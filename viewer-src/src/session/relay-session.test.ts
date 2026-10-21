// RelaySession against in-memory fake relays (command + peer). Replies are built from the
// Task 5 message vectors (registration "3:" / lookup "8:") and the Task 6 screen fixtures.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PipeError } from '../net/pipe';
import { TlsError, type ByteChannel } from '../net/tls';
import { commandCipher, md5Hex } from '../proto/crypto';
import { decodeEnvelope, encodeEnvelope, encodeSystem, keepaliveCommandEnvelope, PreambleDecoder } from '../proto/envelope';
import { encodeFrame, FrameDecoder } from '../proto/frame';
import { decodeMultipart, encodeMultipart } from '../proto/multipart';
import { cursorShapeRequest } from '../proto/cursor';
import { ModernScreenRenderer } from '../proto/screen-renderer';
import { ModernScreenMessageError } from '../proto/screen-message';
import { rawScreenZstd, screenLong, screenParts, screenWords } from '../proto/screen-test-utils';
import { concat, enc, u8 } from '../proto/test-utils';
import type { ClientIdentity } from './identity';
import { COMMAND_ATTEMPT_MS, RelaySession, type SessionEvent } from './relay-session';

// Synthetic values; the secrecy test asserts none of them reaches any emitted string.
const SENTINEL_PASSWORD = 'SENTINEL-partner-secret-7f3a';
const SENTINEL_TOKEN = 'sentineltoken' + 'c0ffee'.repeat(8);
const SENTINEL_IDENTITY: ClientIdentity = {
  deviceIdentity: '0123456789ABCDEF0123456789ABCDEF',
  password: '86420135',
  localAddress: '192.168.1.77',
  macAddress: '02AABBCCDDEE',
};

const COMMAND_HOST = 'functions3.ultraviewer.net';
const COMMAND_IPS = ['192.0.2.9', '192.0.2.4'];
const PARTNER_PUBLIC_IP = '203.0.113.9';
const PARTNER_PORT = 55100;
const RELAY_IP = '198.51.100.2';
const ASSIGNED_ID = '123456789';
const TARGET_ID = '987654321';
const HTTP_OK = enc('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n');

const decoder = new TextDecoder();
const text = (b: Uint8Array) => decoder.decode(b);

/** The relay-side half of an in-memory ByteChannel. Deliveries are async like a socket. */
class FakeChannel implements ByteChannel {
  readonly expired = true;
  closed = false;
  closeReason: string | null = null;
  header: string | null = null;
  readonly frames: Uint8Array[] = [];
  onFrame: (frame: Uint8Array) => void = () => {};
  private readonly dataCbs: ((b: Uint8Array) => void)[] = [];
  private readonly closeCbs: ((r: string) => void)[] = [];
  private readonly pending: Uint8Array[] = [];
  private readonly requestHeader = new PreambleDecoder();
  private readonly framer = new FrameDecoder();
  private headerBytes: number[] = [];

  constructor(readonly ip: string, readonly certName: string) {}

  send(b: Uint8Array): void {
    if (this.closed) return;
    let rest = b;
    if (!this.requestHeader.hasReceivedHeader) {
      rest = this.requestHeader.push(b);
      const consumed = b.length - rest.length;
      this.headerBytes.push(...b.subarray(0, consumed));
      if (this.requestHeader.hasReceivedHeader) this.header = text(Uint8Array.from(this.headerBytes));
    }
    for (const frame of this.framer.push(rest)) {
      this.frames.push(frame);
      this.onFrame(frame);
    }
  }
  onData(cb: (b: Uint8Array) => void): void {
    this.dataCbs.push(cb);
    for (const b of this.pending.splice(0)) cb(b);
  }
  onClose(cb: (r: string) => void): void {
    if (this.closed) cb(this.closeReason ?? 'closed');
    else this.closeCbs.push(cb);
  }
  close(): void {
    this.shut('closed locally');
  }
  /** Relay -> client bytes. */
  deliver(b: Uint8Array): void {
    queueMicrotask(() => {
      if (this.closed) return;
      if (this.dataCbs.length === 0) this.pending.push(b);
      else for (const cb of this.dataCbs) cb(b);
    });
  }
  /** The worker/relay side dropped the connection. */
  shut(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const cb of this.closeCbs.splice(0)) cb(reason);
  }
}

function fromPartner(payload: Uint8Array, address = PARTNER_PUBLIC_IP, port = PARTNER_PORT): Uint8Array {
  return encodeFrame(encodeEnvelope({ kind: 'forward', address, port, formatFlag: false, payload }));
}

const INIT_PARTS = (version = '6.6.133') => [
  u8(0), screenLong(2), screenLong(1), u8(0), u8(0), u8(1), enc(version), u8(1),
];

/** First frame after a reset baseline: sequence -2147483646, a green and a red pixel. */
function firstFrame(sequence = -2_147_483_646): Uint8Array[] {
  const parts = screenParts({ rectangles: [0, 0, 2, 1], pixels: screenWords([0x03e0, 0x7c00]) });
  parts[4] = screenLong(sequence);
  return parts;
}

const lookupSuccess = (correlation: string, port = PARTNER_PORT) =>
  `8:1:192.0.2.77:unused:${PARTNER_PUBLIC_IP}:54000:5900:5901:TmFtZQ==:${port}:unused:${RELAY_IP}:-1:123:relay.example:x:x:x:x:x:partner-token:direct-info:${correlation}`;

interface WorldOptions {
  /** Replies (plaintext after the kind byte) to a lookup with this correlation number. */
  lookupReplies?: (correlation: string) => string[];
  registrationReply?: string | null;
  initParts?: Uint8Array[] | null;
  sendFrameAfter17?: boolean;
  autoPong?: boolean;
  openChannel?: (ip: string, certName: string, signal?: AbortSignal) => Promise<ByteChannel>;
  ips?: string[];
}

class World {
  readonly opens: { ip: string; certName: string }[] = [];
  readonly channels: FakeChannel[] = [];
  readonly events: SessionEvent[] = [];
  readonly commandTexts: string[] = [];
  readonly peerTexts: string[] = [];
  readonly peerSystem: string[] = [];
  /** Every forward envelope to the partner, raw (formatFlag + payload bytes). */
  readonly peerForwards: { formatFlag: boolean; payload: Uint8Array }[] = [];
  readonly session: RelaySession;

  constructor(readonly o: WorldOptions = {}) {
    this.session = new RelaySession({
      openChannel: (ip, certName, signal) => {
        this.opens.push({ ip, certName });
        if (o.openChannel) return o.openChannel(ip, certName, signal);
        return Promise.resolve(this.relay(ip, certName));
      },
      resolve: async (host) => (host === COMMAND_HOST ? (o.ips ?? COMMAND_IPS) : []),
      now: () => Date.now(),
    });
  }

  get command(): FakeChannel | undefined {
    return this.channels.find((c) => c.certName === COMMAND_HOST);
  }
  get peer(): FakeChannel | undefined {
    return this.channels.find((c) => c.certName !== COMMAND_HOST);
  }

  relay(ip: string, certName: string): FakeChannel {
    const ch = new FakeChannel(ip, certName);
    this.channels.push(ch);
    ch.onFrame = certName === COMMAND_HOST ? (f) => this.onCommand(ch, f) : (f) => this.onPeer(ch, f);
    return ch;
  }

  connect(password = SENTINEL_PASSWORD): void {
    this.session.connect(
      { identity: SENTINEL_IDENTITY, partnerID: TARGET_ID, password, screenW: 1920, screenH: 1080, displayName: 'WebViewer' },
      (e) => this.events.push(e),
    );
  }

  private onCommand(ch: FakeChannel, frame: Uint8Array): void {
    const env = decodeEnvelope(frame);
    if (env.kind !== 'system') throw new Error('command channel got a forward envelope');
    expect(env.payload[0]).toBe(0); // explicit format flag false
    const plain = text(commandCipher.decrypt(env.payload.slice(1)));
    this.commandTexts.push(plain);
    let replies: string[] = [];
    if (plain.startsWith('3:')) {
      const reply = this.o.registrationReply === undefined
        ? `3:443:${ASSIGNED_ID}:203.0.113.7:unknown:0:ping-list:0:17/10/2026:relay.example:opaque-token`
        : this.o.registrationReply;
      if (reply !== null) replies = [reply];
      // The HTTP response header and the first frame arrive in one chunk.
      if (replies.length) ch.deliver(concat(HTTP_OK, encodeFrame(encodeSystem(enc(replies.shift()!)))));
      return;
    }
    if (plain.startsWith('8:')) {
      const correlation = plain.split(':')[9]!;
      replies = (this.o.lookupReplies ?? ((c) => [lookupSuccess(c)]))(correlation);
    }
    for (const r of replies) ch.deliver(encodeFrame(encodeSystem(enc(r))));
  }

  private onPeer(ch: FakeChannel, frame: Uint8Array): void {
    const env = decodeEnvelope(frame);
    if (env.kind === 'system') {
      const t = text(env.payload);
      this.peerSystem.push(t);
      if (t === 'ping' && this.o.autoPong !== false) ch.deliver(encodeFrame(encodeSystem(enc('pong'))));
      return;
    }
    expect(env.address).toBe(PARTNER_PUBLIC_IP);
    expect(env.port).toBe(PARTNER_PORT);
    this.peerForwards.push({ formatFlag: env.formatFlag, payload: env.payload });
    const t = text(env.payload);
    this.peerTexts.push(t);
    if (t.startsWith('login:')) {
      if (this.peerTexts.filter((x) => x.startsWith('login:')).length === 1) ch.deliver(HTTP_OK);
      const init = this.o.initParts === undefined ? INIT_PARTS() : this.o.initParts;
      if (init) ch.deliver(fromPartner(encodeMultipart(init)));
    }
    if (t === '17' && this.o.sendFrameAfter17 !== false) ch.deliver(fromPartner(encodeMultipart(firstFrame())));
  }

  closedEvent() {
    return this.events.find((e) => e.type === 'closed');
  }
  statuses(): string[] {
    return this.events.flatMap((e) => (e.type === 'status' ? [e.text] : []));
  }
}

const waitFor = (cond: () => unknown, timeout = 3000) => vi.waitFor(() => expect(cond()).toBeTruthy(), { timeout, interval: 2 });

/** Real yields (setImmediate is left unfaked) so wasm/crypto promises settle under fake timers. */
async function settle(cond: () => unknown, rounds = 2000): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('condition not reached');
}

function useFakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RelaySession', () => {
  test('happy path reaches active and acks frames', async () => {
    const w = new World();
    w.connect();
    await waitFor(() => w.events.some((e) => e.type === 'frame'));

    // Command connection: DNS of functions3, first IP, cert name functions3, Host functions3.
    expect(w.opens[0]).toEqual({ ip: COMMAND_IPS[0], certName: COMMAND_HOST });
    expect(w.command!.header).toContain(`Host: ${COMMAND_HOST}\r\n`);
    expect(w.command!.header).toMatch(/^POST \/UVService\/ HTTP\/1\.1\r\n/);

    // Registration then lookup, both 3DES on the command connection.
    expect(w.commandTexts[0]!.startsWith(`3:${SENTINEL_IDENTITY.deviceIdentity}:${SENTINEL_IDENTITY.password}:0:192.168.1.77:`)).toBe(true);
    const lookup = w.commandTexts[1]!.split(':');
    expect(lookup[0]).toBe('8');
    expect(lookup[1]).toBe(TARGET_ID);
    expect(lookup[2]).toBe(md5Hex(' '.repeat(32) + SENTINEL_PASSWORD));
    expect(lookup[6]).toBe(ASSIGNED_ID);
    expect(lookup[7]).toBe(md5Hex(ASSIGNED_ID + SENTINEL_IDENTITY.password));
    expect(lookup[8]).toBe('-1');
    expect(Number(lookup[9])).toBeGreaterThan(0);
    expect(lookup[13]).toBe(String(-new Date().getTimezoneOffset()));

    // Data connection: relay IP from field 11, cert name and Host = relayHostname (field 14).
    expect(w.opens[1]).toEqual({ ip: RELAY_IP, certName: 'relay.example' });
    expect(w.peer!.header).toContain('Host: relay.example\r\n');

    // Login, then "17" after initialization, then "18" after the decoded frame.
    const login = w.peerTexts[0]!.split(':');
    expect(login[0]).toBe('login');
    expect(login[1]).toMatch(/^[0-9]{8}$/);
    expect(login[2]).toBe(md5Hex(login[1]! + SENTINEL_PASSWORD));
    expect(login.slice(3, 5)).toEqual(['1920', '1080']);
    expect(login[10]).toBe(ASSIGNED_ID);
    expect(login[12]).toBe('0'); // controlMode 0
    expect(login[15]).toMatch(/^[0-9A-Za-z]{16}$/); // connection hash
    expect(login[20]).toBe('partner-token');
    expect(w.peerTexts.slice(1)).toEqual(['17', '28|||1', '18']);

    const accepted = w.events.find((e) => e.type === 'accepted');
    expect(accepted).toEqual({
      type: 'accepted',
      peer: {
        displayName: 'Name', version: '6.6.133', width: 2, height: 1, virtualLeft: 0, virtualTop: 0,
        supportsBinaryKeyboard: true, allowsRemoteInput: true, monitors: [],
      },
    });
    const frame = w.events.find((e) => e.type === 'frame');
    expect(frame?.type === 'frame' && Array.from(frame.bitmap.rgba)).toEqual([0, 255, 0, 255, 255, 0, 0, 255]);
    expect(w.closedEvent()).toBeUndefined();
    expect(w.session.phase).toBe('active');
    expect(w.session.diagnostics.decodedFrames).toBe(1);

    // Status lines cover each step for the diagnostics log.
    const log = w.statuses().join('\n');
    for (const needle of [COMMAND_HOST, COMMAND_IPS[0]!, ASSIGNED_ID, 'lookup status 1', RELAY_IP, '2×1', '6.6.133']) {
      expect(log).toContain(needle);
    }
    expect(log).toContain('expired');

    // Task 8 success criterion: one line for the first drawn frame (size, decode time, bytes).
    const firstBytes = encodeMultipart(firstFrame()).length;
    const firstLines = w.statuses().filter((s) => s.startsWith('frame đầu tiên'));
    expect(firstLines).toHaveLength(1);
    expect(firstLines[0]).toMatch(new RegExp(`^frame đầu tiên: 2×1, giải mã \\d+(\\.\\d)? ms, ${firstBytes} byte$`));
    w.peer!.deliver(fromPartner(encodeMultipart(firstFrame(-2_147_483_645))));
    await waitFor(() => w.session.diagnostics.decodedFrames === 2);
    expect(w.statuses().filter((s) => s.startsWith('frame đầu tiên'))).toHaveLength(1);

    w.session.close();
    expect(w.peerTexts.at(-1)).toBe('19'); // tells the host the viewer is leaving
    expect(w.command!.closed && w.peer!.closed).toBe(true);
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: null });
  });

  test('lookup status 2 → closed(wrongPassword), both channels closed, no reconnect', async () => {
    const w = new World({ lookupReplies: (c) => [`8:2:${c}`] });
    w.connect();
    await waitFor(() => w.closedEvent());
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'wrongPassword' });
    expect(w.command!.closed && w.peer?.closed !== false).toBe(true);
    expect(w.opens).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(w.opens).toHaveLength(1);
    expect(w.events.filter((e) => e.type === 'closed')).toHaveLength(1);
  });

  test('lookup status other than 1/2 → closed(lookupRejected) with the code in the status', async () => {
    const w = new World({ lookupReplies: (c) => [`8:0:${c}`] });
    w.connect();
    await waitFor(() => w.closedEvent());
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'lookupRejected' });
    expect(w.statuses().join('\n')).toContain('lookup status 0');
    expect(w.opens).toHaveLength(1);
  });

  test('lookup route without a usable port → closed(invalidLookupRoute)', async () => {
    const w = new World({ lookupReplies: (c) => [lookupSuccess(c, 0)] });
    w.connect();
    await waitFor(() => w.closedEvent());
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'invalidLookupRoute' });
  });

  test('ignores lookup reply with foreign correlation number', async () => {
    const w = new World({ lookupReplies: (c) => [`8:2:${Number(c) === 1 ? 2 : 1}`, lookupSuccess(c)] });
    w.connect();
    await waitFor(() => w.events.some((e) => e.type === 'accepted'));
    expect(w.closedEvent()).toBeUndefined();
    expect(w.session.diagnostics.lookupStatus).toBe(1);
  });

  test('no reply within 20 s → closed(deadline)', async () => {
    useFakeClock();
    const w = new World({ registrationReply: null });
    w.connect();
    await settle(() => w.commandTexts.length === 1);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(w.closedEvent()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'deadline' });
    expect(w.command!.closed).toBe(true);
  });

  test('peer that never initializes after login → closed(deadline) 20 s after the login', async () => {
    useFakeClock();
    const w = new World({ initParts: null });
    w.connect();
    await settle(() => w.peerTexts.length === 1);
    await vi.advanceTimersByTimeAsync(19_900);
    expect(w.closedEvent()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'deadline' });
    expect(w.command!.closed && w.peer!.closed).toBe(true);
  });

  test('peer channel drops while active → closed(transportClosed) within 1 tick', async () => {
    const w = new World();
    w.connect();
    await waitFor(() => w.events.some((e) => e.type === 'frame'));
    w.peer!.shut('1006');
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'transportClosed' });
    expect(w.command!.closed).toBe(true);
    expect(w.statuses().at(-1)).toContain('1006');
  });

  test('command channel drops while active → closed(transportClosed)', async () => {
    const w = new World();
    w.connect();
    await waitFor(() => w.events.some((e) => e.type === 'frame'));
    w.command!.shut('1006');
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'transportClosed' });
    expect(w.peer!.closed).toBe(true);
  });

  test('normal cadence, dead channel (ping unanswered) → closed(transportClosed) ≤ 20 s after the last byte', async () => {
    useFakeClock();
    const w = new World({ sendFrameAfter17: false });
    w.connect();
    await settle(() => w.session.phase === 'active');
    await vi.advanceTimersByTimeAsync(10_000); // ping -> pong: the relay answers pings
    expect(w.peerSystem).toEqual(['ping']);
    expect(w.closedEvent()).toBeUndefined();
    const silentFrom = Date.now();
    // From now on the connection is dead but nobody tells us (phone locked, NAT dropped).
    w.peer!.onFrame = () => {};
    while (!w.closedEvent() && Date.now() - silentFrom < 25_000) await vi.advanceTimersByTimeAsync(500);
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'transportClosed' });
    expect(Date.now() - silentFrom).toBeLessThanOrEqual(20_000);
  }, 15_000);

  test('late watchdog tick after a 60 s throttling gap, live channel → pings first and stays active', async () => {
    useFakeClock();
    const w = new World({ sendFrameAfter17: false });
    w.connect();
    await settle(() => w.session.phase === 'active');
    await vi.advanceTimersByTimeAsync(10_000); // ping -> pong: the relay answers pings
    const pingsBefore = w.peerSystem.length;
    // Hidden tab, intensive throttling: the clock moves 60 s while no timer runs.
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(1_000); // the first (late) tick
    expect(w.peerSystem.length).toBeGreaterThan(pingsBefore); // a fresh probe went out
    await vi.advanceTimersByTimeAsync(15_000);
    expect(w.closedEvent()).toBeUndefined();
    expect(w.session.phase).toBe('active');
    w.session.close();
  }, 15_000);

  test('late watchdog tick, dead channel → closed(transportClosed) within 20 s of the late tick, not at once', async () => {
    useFakeClock();
    const w = new World({ sendFrameAfter17: false });
    w.connect();
    await settle(() => w.session.phase === 'active');
    await vi.advanceTimersByTimeAsync(10_000);
    w.peer!.onFrame = () => {}; // dead: nothing will ever answer
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const lateTickAt = Date.now();
    expect(w.closedEvent()).toBeUndefined();
    while (!w.closedEvent() && Date.now() - lateTickAt < 25_000) await vi.advanceTimersByTimeAsync(500);
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'transportClosed' });
    expect(Date.now() - lateTickAt).toBeLessThanOrEqual(20_000);
  }, 15_000);

  test.each([
    [27, 'partnerEnded'],
    [41, 'partnerEnded'],
    [54, 'partnerEnded'],
    [39, 'partnerBlocked'],
  ])('partner command %i → closed(%s), both channels closed, timers cleared', async (id, reason) => {
    useFakeClock();
    const w = new World({ sendFrameAfter17: false });
    w.connect();
    await settle(() => w.session.phase === 'active');
    w.peer!.deliver(fromPartner(encodeMultipart([u8(id)])));
    await settle(() => w.closedEvent());
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason });
    expect(w.command!.closed && w.peer!.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const sent = w.peerSystem.length + w.peerTexts.length;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(w.peerSystem.length + w.peerTexts.length).toBe(sent);
    expect(w.events.filter((e) => e.type === 'closed')).toHaveLength(1);
  });

  test('command 48 while active changes the renderer tile size; a malformed 48 closes with protocol', async () => {
    const w = new World({ sendFrameAfter17: false });
    w.connect();
    await waitFor(() => w.session.phase === 'active');
    const renderer = () => (w.session as unknown as { renderer: { tileSize: number } | null }).renderer;
    expect(renderer()!.tileSize).toBe(16);
    w.peer!.deliver(fromPartner(encodeMultipart([u8(48), u8(32)])));
    await waitFor(() => renderer()!.tileSize === 32);
    expect(w.statuses().some((s) => s.startsWith('ignored 48'))).toBe(false);
    expect(w.closedEvent()).toBeUndefined();
    w.peer!.deliver(fromPartner(encodeMultipart([u8(48)])));
    await waitFor(() => w.closedEvent());
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'protocol' });
  });

  test('heartbeats: relay "ping" + peer "20" every 10 s, encrypted command "2" every 60 s', async () => {
    useFakeClock();
    const w = new World({ sendFrameAfter17: false });
    w.connect();
    await settle(() => w.session.phase === 'active');
    const commandFrames = () => w.command!.frames.length;
    const before = commandFrames();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.peerSystem).toEqual(['ping']);
    expect(w.peerTexts.filter((t) => t === '20')).toHaveLength(1);
    expect(commandFrames()).toBe(before);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(w.peerSystem).toHaveLength(6);
    expect(w.peerTexts.filter((t) => t === '20')).toHaveLength(6);
    expect(commandFrames()).toBe(before + 1);
    expect(w.command!.frames.at(-1)).toEqual(keepaliveCommandEnvelope());
    expect(w.session.diagnostics.relayPongs).toBe(6);
    expect(w.closedEvent()).toBeUndefined();
    w.session.close();
  }, 15_000);

  test('a malformed frame is still acknowledged with "18" and triggers one screen refresh login', async () => {
    const w = new World({ sendFrameAfter17: false });
    w.connect();
    await waitFor(() => w.session.phase === 'active');
    w.peer!.deliver(fromPartner(encodeMultipart(firstFrame(5)))); // wrong sequence number
    await waitFor(() => w.peerTexts.filter((t) => t.startsWith('login:')).length === 2);
    expect(w.peerTexts.slice(1, 4)).toEqual(['17', '28|||1', '18']);
    const refresh = w.peerTexts.filter((t) => t.startsWith('login:'))[1]!.split(':');
    expect(refresh[12]).toBe('0'); // clearControlMode
    // The refreshed initialization returns the session to active.
    await waitFor(() => w.session.phase === 'active' && w.peerTexts.filter((t) => t === '17').length === 2);
    expect(w.closedEvent()).toBeUndefined();
    expect(w.statuses().join('\n')).toContain('sequenceMismatch');
    // Control is suspended for the refresh (Swift refreshScreen); cursor positions stay on once.
    expect(w.events).toContainEqual({ type: 'inputPermission', allowed: false });
    expect(w.peerTexts.filter((t) => t === '28|||1')).toHaveLength(1);
  });

  test('unsupported Windows version → closed(unsupportedVersion)', async () => {
    const w = new World({ initParts: INIT_PARTS('5.9.9') });
    w.connect();
    await waitFor(() => w.closedEvent());
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'unsupportedVersion' });
  });

  test('other application ids are logged as ignored once and dropped; foreign sources are dropped', async () => {
    const w = new World({ sendFrameAfter17: false });
    w.connect();
    await waitFor(() => w.session.phase === 'active');
    w.peer!.deliver(fromPartner(encodeMultipart([u8(12), u8(1, 2, 3)])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(12), u8(4)])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(26), enc('not-our-hash')])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(1)]), '192.0.2.200', 1));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(26)]), '192.0.2.200', 1));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(1)]), '192.0.2.200', 2));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(1)]), '192.0.2.200', 1));
    await waitFor(() => w.session.diagnostics.ignoredSources === 4);
    const ignored = w.statuses().filter((s) => s.startsWith('ignored'));
    expect(ignored).toEqual(['ignored 12', 'ignored 26']);
    expect(w.session.diagnostics.ignoredMessages).toBe(3);
    // Each distinct foreign addr:port is logged once (relay switch / stray sender is visible).
    expect(w.statuses().filter((s) => s.startsWith('nguồn lạ'))).toEqual(['nguồn lạ 192.0.2.200:1', 'nguồn lạ 192.0.2.200:2']);
    expect(w.closedEvent()).toBeUndefined();
  });

  test('command IPs are tried in order, 8 s each; the abandoned attempt is aborted and a late connection is closed', async () => {
    expect(COMMAND_ATTEMPT_MS).toBe(8_000);
    useFakeClock();
    let late: (ch: ByteChannel) => void = () => {};
    let lateSignal: AbortSignal | undefined;
    const lateChannel = new FakeChannel('192.0.2.4', COMMAND_HOST);
    const w: World = new World({
      ips: ['192.0.2.1', '192.0.2.4', '192.0.2.9'],
      openChannel: (ip, certName, signal) => {
        if (ip === '192.0.2.1') return Promise.reject(new TlsError('handshake', 'reset'));
        if (ip === '192.0.2.4') {
          lateSignal = signal;
          return new Promise((resolve) => (late = resolve));
        }
        return Promise.resolve(w.relay(ip, certName));
      },
    });
    w.connect();
    await settle(() => w.opens.length === 2);
    expect(lateSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(w.opens).toHaveLength(2);
    expect(lateSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Abandoned: the opener is told to close its pipe (Worker lease) right away.
    expect(lateSignal?.aborted).toBe(true);
    await settle(() => w.opens.length >= 3);
    const commandOpens = w.opens.slice(0, 3);
    expect(commandOpens.map((o) => o.ip)).toEqual(['192.0.2.1', '192.0.2.4', '192.0.2.9']);
    expect(commandOpens.every((o) => o.certName === COMMAND_HOST)).toBe(true);
    late(lateChannel);
    await settle(() => lateChannel.closed);
    await settle(() => w.commandTexts.length >= 1);
    expect(w.command!.ip).toBe('192.0.2.9');
  });

  test('a successful attempt is never aborted afterwards', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const w: World = new World({
      openChannel: (ip, certName, signal) => {
        signals.push(signal);
        return Promise.resolve(w.relay(ip, certName));
      },
    });
    w.connect();
    await waitFor(() => w.events.some((e) => e.type === 'frame'));
    await new Promise((r) => setTimeout(r, 50));
    expect(signals).toHaveLength(2);
    expect(signals.every((sig) => sig !== undefined && !sig.aborted)).toBe(true);
    w.session.close();
  });

  test('an invalid-format token → closed(workerRefused) with a fixed status that never quotes the token', async () => {
    const w = new World({ ips: ['192.0.2.1'], openChannel: () => Promise.reject(new PipeError('invalidToken')) });
    w.connect();
    await waitFor(() => w.closedEvent());
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'workerRefused' });
    expect(w.statuses().at(-1)).toContain('token');
  });

  test('a stray SyntaxError quoting the token never reaches a status', async () => {
    const w = new World({
      ips: ['192.0.2.1'],
      openChannel: () => Promise.reject(new SyntaxError(`The subprotocol '${SENTINEL_TOKEN}' is invalid.`)),
    });
    w.connect();
    await waitFor(() => w.closedEvent());
    expect(JSON.stringify(w.events)).not.toContain(SENTINEL_TOKEN);
  });

  test.each([
    ['TlsError closed carrying 4401', () => new TlsError('closed', 'pipe closed before TLS completed: 4401 bad token'), '4401'],
    ['PipeError 4401', () => new PipeError(4401, 'bad token'), '4401'],
    ['PipeError 4403', () => new PipeError(4403, ''), '4403'],
    ['PipeError 4429', () => new PipeError(4429, ''), '4429'],
    ['TlsError closed carrying 4502', () => new TlsError('closed', 'pipe closed before TLS completed: 4502'), '4502'],
  ])('%s → closed(workerRefused) with the code in the status', async (_name, makeError, code) => {
    const w = new World({ ips: ['192.0.2.1'], openChannel: () => Promise.reject(makeError()) });
    w.connect();
    await waitFor(() => w.closedEvent());
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'workerRefused' });
    expect(w.statuses().at(-1)).toContain(code);
  });

  test('certificate rejection → closed(tls); a plain network close → closed(transportClosed)', async () => {
    const tls = new World({ ips: ['192.0.2.1'], openChannel: () => Promise.reject(new TlsError('name', 'certificate rejected: name')) });
    tls.connect();
    await waitFor(() => tls.closedEvent());
    expect(tls.events.at(-1)).toEqual({ type: 'closed', reason: 'tls' });

    const net = new World({ ips: ['192.0.2.1'], openChannel: () => Promise.reject(new PipeError(1006, '')) });
    net.connect();
    await waitFor(() => net.closedEvent());
    expect(net.events.at(-1)).toEqual({ type: 'closed', reason: 'transportClosed' });
  });

  test('no A record for the command host → closed(transportClosed)', async () => {
    const w = new World({ ips: [] });
    w.connect();
    await waitFor(() => w.closedEvent());
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'transportClosed' });
    expect(w.opens).toHaveLength(0);
  });

  test('connect validates the partner and refuses a second open session', () => {
    const w = new World();
    const options = { identity: SENTINEL_IDENTITY, password: 'x', screenW: 1, screenH: 1, displayName: 'WebViewer' };
    expect(() => w.session.connect({ ...options, partnerID: '12a' }, () => {})).toThrow(/invalidPartner/);
    expect(() => w.session.connect({ ...options, partnerID: '' }, () => {})).toThrow(/invalidPartner/);
    expect(() => w.session.connect({ ...options, partnerID: '1', password: '' }, () => {})).toThrow(/invalidPartner/);
    expect(() => w.session.connect({ ...options, partnerID: '1', password: 'mật' }, () => {})).toThrow(/invalidPartner/);
    w.connect();
    expect(() => w.connect()).toThrow(/alreadyOpen/);
    w.session.close();
  });

  test('close() during lookup closes the command channel and emits closed(null) once', async () => {
    const w = new World({ lookupReplies: () => [] });
    w.connect();
    await waitFor(() => w.commandTexts.length === 2);
    w.session.close();
    w.session.close();
    expect(w.command!.closed).toBe(true);
    expect(w.events.filter((e) => e.type === 'closed')).toEqual([{ type: 'closed', reason: null }]);
    expect(w.session.phase).toBe('closed');
  });

  test('secrets never appear in any status or event: password, token, client password, MD5 proofs', async () => {
    // The token lives only in the transport opener's closure (Sec-WebSocket-Protocol in production).
    const failing = new World({
      ips: ['192.0.2.1'],
      openChannel: () => Promise.reject(new TlsError('closed', 'pipe closed before TLS completed: 4401 bad token')),
    });
    const tokenHolder = { token: SENTINEL_TOKEN };
    failing.connect();
    await waitFor(() => failing.closedEvent());

    const w = new World();
    w.connect();
    await waitFor(() => w.events.some((e) => e.type === 'frame'));
    w.peer!.deliver(fromPartner(encodeMultipart(firstFrame(99))));
    await waitFor(() => w.peerTexts.filter((t) => t.startsWith('login:')).length === 2);
    w.session.close();

    const login = w.peerTexts[0]!.split(':');
    const lookup = w.commandTexts[1]!.split(':');
    const secrets = [
      SENTINEL_PASSWORD, tokenHolder.token, SENTINEL_IDENTITY.password,
      lookup[2]!, lookup[7]!, login[2]!, login[13]!, login[15]!,
    ];
    const emitted = [...failing.events, ...w.events]
      .map((e) => (e.type === 'frame' ? 'frame' : JSON.stringify(e)))
      .join('\n');
    expect(emitted.length).toBeGreaterThan(200);
    for (const secret of secrets) expect(emitted).not.toContain(secret);
    expect(JSON.stringify(w.session.diagnostics)).not.toContain(SENTINEL_PASSWORD);
  });

  test('decodes the partner messages it sends as multipart', () => {
    // Guard for the fixtures above: a frame is a multipart payload whose first part is command 1.
    expect(decodeMultipart(encodeMultipart(firstFrame()))[0]).toEqual(u8(1));
  });
});

// Phase 1 Task 2: control API, input permission (49), cursor (3/4/28), host re-login (23).
describe('RelaySession control', () => {
  const unicode = (t: string) => Uint8Array.from(Array.from(t).flatMap((c) => [c.charCodeAt(0), 0]));
  const inputPermissions = (w: World) => w.events.flatMap((e) => (e.type === 'inputPermission' ? [e.allowed] : []));
  const cursorEvents = (w: World) => w.events.flatMap((e) => (e.type === 'cursor' ? [e.event] : []));
  const logins = (w: World) => w.peerTexts.filter((t) => t.startsWith('login:'));

  async function activeWorld(o: WorldOptions = {}): Promise<World> {
    const w = new World({ sendFrameAfter17: false, ...o });
    w.connect();
    await waitFor(() => w.session.phase === 'active' && w.peerTexts.includes('28|||1'));
    return w;
  }

  test('(a) command 49: flag 1 → inputPermission(false), flag 0 → true; sendCommand follows it', async () => {
    const w = await activeWorld();
    w.peer!.deliver(fromPartner(encodeMultipart([u8(49), u8(1)])));
    await waitFor(() => inputPermissions(w).length === 1);
    expect(inputPermissions(w)).toEqual([false]);
    w.peer!.deliver(fromPartner(encodeMultipart([u8(49), u8(0)])));
    await waitFor(() => inputPermissions(w).length === 2);
    expect(inputPermissions(w)).toEqual([false, true]);
    expect(w.statuses().some((s) => s.startsWith('ignored 49'))).toBe(false);
    // A 49 without its flag byte is malformed (Swift malformedInitialization).
    w.peer!.deliver(fromPartner(encodeMultipart([u8(49)])));
    await waitFor(() => w.closedEvent());
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'protocol' });
  });

  test('(a) command 49 before active emits nothing, but the first accepted peer reports view-only', async () => {
    const w = new World({ initParts: null, sendFrameAfter17: false });
    w.connect();
    await waitFor(() => logins(w).length === 1);
    w.peer!.deliver(fromPartner(encodeMultipart([u8(49), u8(1)])));
    w.peer!.deliver(fromPartner(encodeMultipart(INIT_PARTS())));
    await waitFor(() => w.session.phase === 'active');
    expect(inputPermissions(w)).toEqual([]);
    const accepted = w.events.find((e) => e.type === 'accepted');
    expect(accepted?.type === 'accepted' && accepted.peer.allowsRemoteInput).toBe(false);
    await expect(w.session.sendCommand({ type: 'action', action: 'lock' }, { requiresControl: true }))
      .rejects.toMatchObject({ code: 'viewOnly' });
  });

  test('(b) sendCommand(ctrlAltDel): view-only → reject viewOnly; allowed → UTF-16LE "22" with formatFlag', async () => {
    const w = await activeWorld();
    w.peer!.deliver(fromPartner(encodeMultipart([u8(49), u8(1)])));
    await waitFor(() => inputPermissions(w).length === 1);
    const sent = w.peerForwards.length;
    await expect(w.session.sendCommand({ type: 'action', action: 'ctrlAltDel' }, { requiresControl: true }))
      .rejects.toMatchObject({ name: 'RelaySessionError', code: 'viewOnly' });
    expect(w.peerForwards.length).toBe(sent);
    // A command that needs no control still goes out while view-only.
    await w.session.sendCommand({ type: 'quality', preset: 'speed' }, { requiresControl: false });
    expect(w.peerForwards.slice(sent).map((f) => [f.formatFlag, text(f.payload)])).toEqual([
      [false, '32|||2'], [false, '31|||30'],
    ]);

    w.peer!.deliver(fromPartner(encodeMultipart([u8(49), u8(0)])));
    await waitFor(() => inputPermissions(w).length === 2);
    await w.session.sendCommand({ type: 'action', action: 'ctrlAltDel' }, { requiresControl: true });
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('22') });
    await w.session.sendCommand({ type: 'wallpaper', visible: false }, { requiresControl: true });
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('23|||0') });
    w.session.close();
  });

  test('(c) after accepted the peer receives "28|||1" (cursor positions on) right after "17"', async () => {
    const w = await activeWorld();
    expect(w.peerTexts.slice(1, 3)).toEqual(['17', '28|||1']);
    const cursorOn = w.peerForwards.find((f) => text(f.payload) === '28|||1');
    expect(cursorOn?.formatFlag).toBe(false);
  });

  test('(d) commands 3/4/28 while active → cursor events; ignored hash and malformed messages are dropped', async () => {
    const w = await activeWorld();
    const cur = u8(0, 0, 2, 0, 1, 0, 32, 32, 0, 0, 3, 0, 5, 0, 4, 0, 0, 0, 22, 0, 0, 0, 0xaa, 0xbb, 0xcc, 0xdd);
    w.peer!.deliver(fromPartner(encodeMultipart([u8(3), screenLong(0xb84d1a70 | 0)]))); // ignored hash
    w.peer!.deliver(fromPartner(encodeMultipart([u8(3), screenLong(-12345)])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(28), u8(0x2c, 0x01), u8(0xf6, 0xff)])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(28), u8(1)]))); // malformed: dropped, session stays
    w.peer!.deliver(fromPartner(encodeMultipart([u8(4), screenLong(-7), screenLong(cur.length), rawScreenZstd(cur)])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(4), screenLong(-8), screenLong(cur.length), u8(1, 2, 3)]))); // bad zstd
    w.peer!.deliver(fromPartner(encodeMultipart([u8(28), u8(0, 0), u8(0, 0)])));
    await waitFor(() => cursorEvents(w).length === 4);
    expect(cursorEvents(w)).toEqual([
      { type: 'select', hash: -12345 },
      { type: 'position', x: 300, y: -10 },
      { type: 'shape', hash: -7, cur },
      { type: 'position', x: 0, y: 0 },
    ]);
    expect(w.statuses().some((s) => /^ignored (3|4|28)$/.test(s))).toBe(false);
    expect(w.closedEvent()).toBeUndefined();
    // The session never caches or requests shapes itself: the UI asks with send(cursorShapeRequest).
    expect(w.peerTexts.some((t) => t.startsWith('4|||'))).toBe(false);
    await w.session.send(cursorShapeRequest(-12345));
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: false, payload: enc('4|||-12345') });
  });

  test('(d) cursor messages before active are dropped', async () => {
    const w = new World({ initParts: null, sendFrameAfter17: false });
    w.connect();
    await waitFor(() => logins(w).length === 1);
    w.peer!.deliver(fromPartner(encodeMultipart([u8(28), u8(1, 0), u8(2, 0)])));
    w.peer!.deliver(fromPartner(encodeMultipart(INIT_PARTS())));
    await waitFor(() => w.session.phase === 'active');
    expect(cursorEvents(w)).toEqual([]);
    w.session.close();
  });

  test('(e) command 23 while active → login again with controlMode -1, renderer kept, back to active', async () => {
    const w = await activeWorld();
    const renderer = () => (w.session as unknown as { renderer: unknown }).renderer;
    const before = renderer();
    w.peer!.deliver(fromPartner(encodeMultipart([u8(23)])));
    await waitFor(() => logins(w).length === 2);
    const relogin = logins(w)[1]!.split(':');
    expect(relogin[12]).toBe('-1'); // controlMode -1, clearControlMode false
    expect(relogin[15]).toBe(logins(w)[0]!.split(':')[15]); // same connection hash
    await waitFor(() => w.session.phase === 'active' && w.peerTexts.filter((t) => t === '17').length === 2);
    expect(renderer()).toBe(before); // same geometry: the renderer is not re-created
    expect(w.statuses().some((s) => s.startsWith('ignored 23'))).toBe(false);
    expect(w.closedEvent()).toBeUndefined();
  });

  test('(e) command 23 before active is ignored (no second login)', async () => {
    const w = new World({ initParts: null, sendFrameAfter17: false });
    w.connect();
    await waitFor(() => logins(w).length === 1);
    w.peer!.deliver(fromPartner(encodeMultipart([u8(23)])));
    w.peer!.deliver(fromPartner(encodeMultipart(INIT_PARTS())));
    await waitFor(() => w.session.phase === 'active');
    expect(logins(w)).toHaveLength(1);
    w.session.close();
  });

  test('(e) a re-login the host never answers closes with deadline after 20 s', async () => {
    useFakeClock();
    const w = new World({ sendFrameAfter17: false });
    w.connect();
    await settle(() => w.session.phase === 'active');
    w.peer!.onFrame = () => {}; // the host stops answering
    w.peer!.deliver(fromPartner(encodeMultipart([u8(23)])));
    await settle(() => w.session.phase === 'login');
    await vi.advanceTimersByTimeAsync(19_900);
    expect(w.closedEvent()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'deadline' });
  });

  test('(f) send / sendCommand / refreshScreen before active → reject notConnected', async () => {
    const w = new World({ initParts: null });
    await expect(w.session.send(enc('8|||x'))).rejects.toMatchObject({ code: 'notConnected' });
    w.connect();
    await waitFor(() => logins(w).length === 1);
    await expect(w.session.send(enc('8|||x'))).rejects.toMatchObject({ name: 'RelaySessionError', code: 'notConnected' });
    await expect(w.session.sendCommand({ type: 'action', action: 'lock' }, { requiresControl: false }))
      .rejects.toMatchObject({ code: 'notConnected' });
    await expect(w.session.refreshScreen()).rejects.toMatchObject({ code: 'notConnected' });
    expect(logins(w)).toHaveLength(1);
    w.session.close();
    await expect(w.session.send(enc('8|||x'))).rejects.toMatchObject({ code: 'notConnected' });
  });

  test('refreshScreen: inputPermission(false) first, clear-mode login, send still works for releaseAll', async () => {
    const w = new World({ sendFrameAfter17: false, initParts: null });
    w.connect();
    await waitFor(() => logins(w).length === 1);
    w.peer!.deliver(fromPartner(encodeMultipart(INIT_PARTS())));
    await waitFor(() => w.session.phase === 'active');
    const order: string[] = [];
    const seen = w.events.length;
    await w.session.refreshScreen();
    for (const e of w.events.slice(seen)) order.push(e.type);
    expect(order[0]).toBe('inputPermission');
    expect(w.events[seen]).toEqual({ type: 'inputPermission', allowed: false });
    expect(w.session.phase).toBe('login');
    expect(logins(w)).toHaveLength(2);
    expect(logins(w)[1]!.split(':')[12]).toBe('0'); // clearControlMode
    // Held keys can still be released during the authenticated refresh (Swift send()).
    await w.session.send(u8(30, 0x7c, 0x7c, 0x7c, 2, 0x41, 0x1e, 0, 0x61, 0, 0));
    expect(w.peerForwards.at(-1)?.payload[0]).toBe(30);
    w.peer!.deliver(fromPartner(encodeMultipart(INIT_PARTS())));
    await waitFor(() => w.session.phase === 'active');
    expect(w.session.diagnostics.screenRefreshes).toBe(1);
    w.session.close();
  });

  test('accepted peer: binary keyboard from 6.2.13, monitors from init part 8, virtual origin from parts 9/10', async () => {
    const parts = [...INIT_PARTS('6.2.12'), enc('-1:0:1:1|'), screenLong(-1), screenLong(0)];
    const w = await activeWorld({ initParts: parts });
    const accepted = w.events.find((e) => e.type === 'accepted');
    expect(accepted?.type === 'accepted' && accepted.peer).toMatchObject({
      version: '6.2.12', supportsBinaryKeyboard: false, allowsRemoteInput: true,
      monitors: [{ index: 1, left: -1, top: 0, right: 1, bottom: 1 }], virtualLeft: -1, virtualTop: 0,
    });

    const bad = await activeWorld({ initParts: [...INIT_PARTS('6.2.13'), enc('garbage'), screenLong(0), screenLong(0)] });
    const peer = bad.events.find((e) => e.type === 'accepted');
    expect(peer?.type === 'accepted' && peer.peer).toMatchObject({ supportsBinaryKeyboard: true, monitors: [] });
    expect(bad.statuses().filter((s) => s.startsWith('monitor'))).toHaveLength(1);
  });

  describe('screen refresh limits and stale decodes (phase 1 final review)', () => {
    afterEach(() => vi.restoreAllMocks());
    const malformed = () => encodeMultipart(firstFrame(5)); // wrong sequence number
    const loginsOf = (w: World) => w.peerTexts.filter((t) => t.startsWith('login:'));

    test('manual refreshes never count toward the decode-error limit', async () => {
      const w = new World();
      w.connect();
      await waitFor(() => w.session.diagnostics.decodedFrames === 1);
      for (const n of [2, 3]) {
        await w.session.refreshScreen();
        await waitFor(() => w.session.phase === 'active' && w.session.diagnostics.decodedFrames === n);
      }
      w.peer!.deliver(fromPartner(malformed()));
      await waitFor(() => loginsOf(w).length === 4);
      await waitFor(() => w.session.phase === 'active' && w.session.diagnostics.decodedFrames === 4);
      expect(w.closedEvent()).toBeUndefined();
      w.session.close();
    });

    test('decode-error refreshes that each recover (init + a good frame) reset the limit', async () => {
      const w = new World();
      w.connect();
      await waitFor(() => w.session.diagnostics.decodedFrames === 1);
      for (const n of [2, 3, 4]) {
        w.peer!.deliver(fromPartner(malformed()));
        await waitFor(() => w.session.phase === 'active' && w.session.diagnostics.decodedFrames === n);
      }
      expect(loginsOf(w)).toHaveLength(4);
      expect(w.closedEvent()).toBeUndefined();
      w.session.close();
    });

    test('malformed frames right after every init still close the session (refresh-loop protection)', async () => {
      const w = new World({ sendFrameAfter17: false });
      w.connect();
      await waitFor(() => w.session.phase === 'active' && w.peerTexts.includes('28|||1'));
      for (const n of [2, 3]) {
        w.peer!.deliver(fromPartner(malformed()));
        await waitFor(() => w.session.phase === 'active' && w.peerTexts.filter((t) => t === '17').length === n);
      }
      w.peer!.deliver(fromPartner(malformed()));
      await waitFor(() => w.closedEvent());
      expect(w.events.at(-1)).toEqual({ type: 'closed', reason: 'protocol' });
    });

    test('a frame still decoding when the screen is refreshed emits no frame event and no "18"', async () => {
      const w = await activeWorld();
      let release: (b: { width: number; height: number; rgba: Uint8ClampedArray }) => void = () => {};
      const apply = vi.spyOn(ModernScreenRenderer.prototype, 'apply').mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve as typeof release)),
      );
      w.peer!.deliver(fromPartner(encodeMultipart(firstFrame())));
      await waitFor(() => apply.mock.calls.length === 1);
      await w.session.refreshScreen(); // manual refresh while the frame is decoding
      expect(w.session.phase).toBe('login');
      release({ width: 2, height: 1, rgba: new Uint8ClampedArray(8) });
      await waitFor(() => w.session.phase === 'active' && w.peerTexts.filter((t) => t === '17').length === 2);
      await new Promise((r) => setTimeout(r, 20));
      expect(w.events.some((e) => e.type === 'frame')).toBe(false);
      expect(w.peerTexts.filter((t) => t === '18')).toHaveLength(0);
      expect(w.session.diagnostics.decodedFrames).toBe(0);
      expect(w.closedEvent()).toBeUndefined();
      w.session.close();
    });

    test('a stale frame that fails to decode after a refresh does not trigger another refresh', async () => {
      const w = await activeWorld();
      let fail: (e: unknown) => void = () => {};
      const apply = vi.spyOn(ModernScreenRenderer.prototype, 'apply').mockImplementationOnce(
        () => new Promise((_, reject) => (fail = reject)),
      );
      w.peer!.deliver(fromPartner(encodeMultipart(firstFrame())));
      await waitFor(() => apply.mock.calls.length === 1);
      await w.session.refreshScreen();
      fail(new ModernScreenMessageError('sequenceMismatch', { expected: 1, received: 2 }));
      await waitFor(() => w.session.phase === 'active' && w.peerTexts.filter((t) => t === '17').length === 2);
      await new Promise((r) => setTimeout(r, 20));
      expect(loginsOf(w)).toHaveLength(2);
      expect(w.peerTexts.filter((t) => t === '18')).toHaveLength(0);
      expect(w.closedEvent()).toBeUndefined();
      w.session.close();
    });
  });
});
