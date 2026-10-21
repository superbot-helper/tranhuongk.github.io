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
import { utf16le } from '../proto/utf16';
import { rawZstdFrame } from '../proto/clipboard';
import { readFileSync } from 'node:fs';
import type { FileSink, FileSource } from './file-engine';
import type { PcmDecoder } from './control';
import type { ClientIdentity } from './identity';
import { COMMAND_ATTEMPT_MS, RelaySession, type RelaySessionDeps, type SessionEvent } from './relay-session';

// Synthetic values; the secrecy test asserts none of them reaches any emitted string.
const SENTINEL_PASSWORD = 'SENTINEL-partner-secret-7f3a';
const SENTINEL_STRAY = 'sentinelstray' + 'c0ffee'.repeat(8);
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
  deps?: Partial<RelaySessionDeps>;
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
      ...o.deps,
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
    w.peer!.deliver(fromPartner(encodeMultipart([u8(60), u8(1, 2, 3)])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(60), u8(4)])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(26), enc('not-our-hash')])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(1)]), '192.0.2.200', 1));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(26)]), '192.0.2.200', 1));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(1)]), '192.0.2.200', 2));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(1)]), '192.0.2.200', 1));
    await waitFor(() => w.session.diagnostics.ignoredSources === 4);
    const ignored = w.statuses().filter((s) => s.startsWith('ignored'));
    expect(ignored).toEqual(['ignored 60', 'ignored 26']);
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

  test('a stray SyntaxError quoting its input never reaches a status', async () => {
    const w = new World({
      ips: ['192.0.2.1'],
      openChannel: () => Promise.reject(new SyntaxError(`The URL '${SENTINEL_STRAY}' is invalid.`)),
    });
    w.connect();
    await waitFor(() => w.closedEvent());
    expect(JSON.stringify(w.events)).not.toContain(SENTINEL_STRAY);
  });

  test.each([
    ['TlsError closed carrying 4429', () => new TlsError('closed', 'pipe closed before TLS completed: 4429 too many connections'), '4429'],
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

  test('secrets never appear in any status or event: password, client password, MD5 proofs', async () => {
    const failing = new World({
      ips: ['192.0.2.1'],
      openChannel: () => Promise.reject(new TlsError('closed', 'pipe closed before TLS completed: 4403 forbidden target')),
    });
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
      SENTINEL_PASSWORD, SENTINEL_IDENTITY.password,
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

// Phase 2 Task 3: chat 12/29/30, clipboard 5/33, computer audio 42/43 and the tool gate.
describe('RelaySession tools', () => {
  const unicode = (t: string) => utf16le(t);
  const chatEvents = (w: World) => w.events.flatMap((e) => (e.type === 'chat' ? [e.text] : []));
  const typingEvents = (w: World) => w.events.flatMap((e) => (e.type === 'typing' ? [e.typing] : []));
  const clipboardEvents = (w: World) => w.events.flatMap((e) => (e.type === 'clipboard' ? [e.text] : []));
  const audioEvents = (w: World) => w.events.flatMap((e) => (e.type === 'audio' ? [e.pcm] : []));
  const toolsEvents = (w: World) => w.events.flatMap((e) => (e.type === 'tools' ? [e.available] : []));
  const long = (n: number) => u8(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  const deliver = (w: World, parts: Uint8Array[]) => w.peer!.deliver(fromPartner(encodeMultipart(parts)));
  const NAUDIO = (JSON.parse(readFileSync(new URL('../../test/fixtures/g722-windows.json', import.meta.url), 'utf8')) as {
    Fixtures: { EncodedBase64: string; PCMBase64: string }[];
  }).Fixtures[0]!;
  const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
  const toInt16 = (bytes: Uint8Array) => new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));

  async function activeWorld(o: WorldOptions = {}): Promise<World> {
    const w = new World({ sendFrameAfter17: false, ...o });
    w.connect();
    await waitFor(() => w.session.phase === 'active' && w.peerTexts.includes('28|||1'));
    return w;
  }

  test('gate: nothing is usable before accepted; tools events follow the gate; everything resets on close', async () => {
    const w = new World({ initParts: null, sendFrameAfter17: false });
    expect(w.session.canUseSessionTools()).toBe(false);
    w.connect();
    await waitFor(() => w.peerTexts.some((t) => t.startsWith('login:')));
    expect(w.session.phase).toBe('login');
    expect(w.session.canUseSessionTools()).toBe(false);
    await expect(w.session.sendChat('hi')).rejects.toMatchObject({ name: 'RelaySessionError', code: 'toolsUnavailable' });
    await expect(w.session.sendTyping(true)).rejects.toMatchObject({ code: 'toolsUnavailable' });
    await expect(w.session.sendClipboard('x')).rejects.toMatchObject({ code: 'toolsUnavailable' });
    expect(() => w.session.setClipboardSharing(true)).toThrowError(expect.objectContaining({ code: 'toolsUnavailable' }));
    await expect(w.session.setComputerAudio(true)).rejects.toMatchObject({ code: 'notConnected' });
    // Incoming tool messages before the first init are dropped too.
    deliver(w, [u8(12, 0), unicode('early')]);
    deliver(w, [u8(29, 0)]);
    deliver(w, INIT_PARTS());
    await waitFor(() => w.session.phase === 'active');
    expect(chatEvents(w)).toEqual([]);
    expect(typingEvents(w)).toEqual([]);
    expect(toolsEvents(w)).toEqual([true]);
    expect(w.session.canUseSessionTools()).toBe(true);
    // `tools` follows `accepted`.
    expect(w.events.findIndex((e) => e.type === 'tools')).toBeGreaterThan(w.events.findIndex((e) => e.type === 'accepted'));
    w.session.close();
    expect(w.session.canUseSessionTools()).toBe(false);
    expect(toolsEvents(w)).toEqual([true, false]);
    expect(w.events.findIndex((e) => e.type === 'tools' && !e.available)).toBeLessThan(w.events.findIndex((e) => e.type === 'closed'));
    await expect(w.session.sendChat('late')).rejects.toMatchObject({ code: 'toolsUnavailable' });
  });

  test('gate: the tools stay available during a host re-login (23) and a screen refresh', async () => {
    const w = await activeWorld();
    deliver(w, [u8(23)]);
    await waitFor(() => w.session.phase === 'login' || logins(w).length === 2);
    await w.session.sendChat('still here');
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('12|||still here') });
    await waitFor(() => w.session.phase === 'active');
    expect(toolsEvents(w)).toEqual([true]);
    await w.session.refreshScreen();
    expect(w.session.phase).toBe('login');
    expect(w.session.canUseSessionTools()).toBe(true);
    await w.session.sendTyping(true);
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('29') });
    expect(toolsEvents(w)).toEqual([true]);
    w.session.close();
  });
  const logins = (w: World) => w.peerTexts.filter((t) => t.startsWith('login:'));

  test('chat: sends UTF-16LE "12|||text" and typing "29"/"30" with flag true; local policy rejects', async () => {
    const w = await activeWorld();
    await w.session.sendChat('xin chào 😀');
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('12|||xin chào 😀') });
    await w.session.sendTyping(true);
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('29') });
    await w.session.sendTyping(false);
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('30') });
    const sent = w.peerForwards.length;
    await expect(w.session.sendChat('a|||b')).rejects.toMatchObject({ name: 'ChatError', code: 'unsupportedDelimiter' });
    await expect(w.session.sendChat('a\u0001b')).rejects.toMatchObject({ code: 'invalidText' });
    await expect(w.session.sendChat('x'.repeat(16 * 1024 + 1))).rejects.toMatchObject({ code: 'textTooLarge' });
    expect(w.peerForwards.length).toBe(sent);
    w.session.close();
  });

  test('chat: receives 12 (UTF-16LE) and 29/30, drops malformed chat, never logs the text', async () => {
    const w = await activeWorld();
    deliver(w, [u8(12, 0), unicode('Chào bạn 👋 SENTINELCHAT')]);
    deliver(w, [u8(29, 0)]);
    deliver(w, [u8(30)]); // one-byte command form
    deliver(w, [u8(12, 0), u8(0x61)]); // odd UTF-16: dropped
    deliver(w, [u8(12, 0), unicode('a\u0001')]); // control char: dropped
    deliver(w, [u8(29, 0), u8(1)]); // typing with a body: dropped
    deliver(w, [u8(12, 0), unicode('sau')]);
    await waitFor(() => chatEvents(w).length === 2);
    expect(chatEvents(w)).toEqual(['Chào bạn 👋 SENTINELCHAT', 'sau']);
    expect(typingEvents(w)).toEqual([true, false]);
    expect(w.closedEvent()).toBeUndefined();
    expect(w.statuses().join('\n')).not.toContain('SENTINELCHAT');
    expect(w.statuses().some((s) => /^ignored (12|29|30)$/.test(s))).toBe(false);
    w.session.close();
  });

  test('chat does not depend on the control permission (49 view-only)', async () => {
    const w = await activeWorld();
    deliver(w, [u8(49), u8(1)]);
    await waitFor(() => w.events.some((e) => e.type === 'inputPermission'));
    await w.session.sendChat('view only');
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('12|||view only') });
    deliver(w, [u8(12, 0), unicode('reply')]);
    await waitFor(() => chatEvents(w).length === 1);
    w.session.close();
  });

  test('clipboard: off by default — incoming 5/33 dropped silently, sending rejected, nothing sent on toggle', async () => {
    const w = await activeWorld();
    const sent = w.peerForwards.length;
    deliver(w, [u8(5), unicode('SENTINELCLIP')]);
    deliver(w, [u8(33), long(2), rawZstdFrame(unicode('a'))]);
    await expect(w.session.sendClipboard('SENTINELCLIP')).rejects.toMatchObject({ name: 'RelaySessionError', code: 'clipboardDisabled' });
    // Let the deliveries run (the next message in the queue is observed).
    deliver(w, [u8(12, 0), unicode('marker')]);
    await waitFor(() => chatEvents(w).length === 1);
    expect(clipboardEvents(w)).toEqual([]);
    expect(w.statuses().join('\n')).not.toContain('SENTINELCLIP');
    expect(w.statuses().filter((s) => s === 'clipboard bị bỏ (đang tắt)')).toHaveLength(1);
    expect(w.statuses().some((s) => /^ignored (5|33)$/.test(s))).toBe(false);
    w.session.setClipboardSharing(true);
    w.session.setClipboardSharing(false);
    expect(w.peerForwards.length).toBe(sent);
    w.session.close();
  });

  test('clipboard: on — modern 33 and legacy 5 emit events; malformed/oversized are dropped; sends the modern payload', async () => {
    const w = await activeWorld();
    w.session.setClipboardSharing(true);
    const text = 'Dán: Δ 😀 | ||';
    const utf16 = unicode(text);
    deliver(w, [u8(33), long(utf16.length), rawZstdFrame(utf16)]);
    deliver(w, [u8(5), unicode('legacy ✓')]);
    deliver(w, [u8(33), long(utf16.length + 2), rawZstdFrame(utf16)]); // length mismatch
    deliver(w, [u8(5), u8(0x61)]); // odd UTF-16
    deliver(w, [u8(33), long(2), u8(1, 2, 3)]); // bad zstd
    deliver(w, [u8(5), unicode('a\0b')]); // NUL
    deliver(w, [u8(33), long(2 * 1024 * 1024)]); // over the limit, truncated
    deliver(w, [u8(5), unicode('cuối')]);
    await waitFor(() => clipboardEvents(w).length === 3);
    expect(clipboardEvents(w)).toEqual([text, 'legacy ✓', 'cuối']);
    expect(w.closedEvent()).toBeUndefined();

    await w.session.sendClipboard('gửi đi');
    const out = w.peerForwards.at(-1)!;
    expect(out.formatFlag).toBe(false);
    const body = unicode('gửi đi');
    expect(out.payload).toEqual(concat(enc(`33|||${body.length}|||`), rawZstdFrame(body)));
    await w.session.sendClipboard('');
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('5|||') });
    await expect(w.session.sendClipboard('x'.repeat(524_289))).rejects.toMatchObject({ code: 'sizeLimitExceeded' });
    w.session.close();
  });

  test('clipboard: turning sharing off rejects sends again; closing resets the flag', async () => {
    const w = await activeWorld();
    w.session.setClipboardSharing(true);
    w.session.setClipboardSharing(false);
    await expect(w.session.sendClipboard('x')).rejects.toMatchObject({ code: 'clipboardDisabled' });
    w.session.setClipboardSharing(true);
    const flags = () => w.session as unknown as { clipboardAllowed: boolean; audioEnabled: boolean };
    await w.session.setComputerAudio(true);
    expect([flags().clipboardAllowed, flags().audioEnabled]).toEqual([true, true]);
    w.session.close();
    expect([flags().clipboardAllowed, flags().audioEnabled]).toEqual([false, false]);
  });

  test('clipboard: a zstd decoder that cannot load drops the message and is logged once without text', async () => {
    const w = await activeWorld({ deps: { makeClipboardZstd: () => Promise.reject(new Error('boom')) } });
    w.session.setClipboardSharing(true);
    const utf16 = unicode('SENTINELCLIP');
    deliver(w, [u8(33), long(utf16.length), rawZstdFrame(utf16)]);
    deliver(w, [u8(33), long(utf16.length), rawZstdFrame(utf16)]);
    deliver(w, [u8(5), unicode('legacy ok')]);
    await waitFor(() => clipboardEvents(w).length === 1);
    expect(clipboardEvents(w)).toEqual(['legacy ok']);
    expect(w.statuses().filter((s) => s.startsWith('Không tải được zstd cho clipboard'))).toHaveLength(1);
    expect(w.statuses().join('\n')).not.toContain('SENTINELCLIP');
    w.session.close();
  });

  test('audio: setComputerAudio sends UTF-16LE "46|||-1"/"46|||0" (flag true), active only', async () => {
    const w = await activeWorld();
    await w.session.setComputerAudio(true);
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('46|||-1') });
    await w.session.setComputerAudio(false);
    expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('46|||0') });
    // Not allowed while re-authenticating.
    await w.session.refreshScreen();
    await expect(w.session.setComputerAudio(true)).rejects.toMatchObject({ code: 'notConnected' });
    w.session.close();
    await expect(w.session.setComputerAudio(true)).rejects.toMatchObject({ code: 'notConnected' });
  });

  test('audio: 43 decodes the NAudio fixture packet by packet; 42 emits zero samples; muted (46 off) forwards nothing but keeps decoding', async () => {
    const w = await activeWorld();
    const encoded = b64(NAUDIO.EncodedBase64);
    const expected = toInt16(b64(NAUDIO.PCMBase64));
    const cut = Math.floor(encoded.length / 3);
    const chunks = [encoded.subarray(0, cut), encoded.subarray(cut, 2 * cut), encoded.subarray(2 * cut)];
    // Audio is off: the middle packet is decoded (state advances) but not forwarded.
    await w.session.setComputerAudio(true);
    deliver(w, [u8(43), chunks[0]!]);
    await waitFor(() => audioEvents(w).length === 1);
    await w.session.setComputerAudio(false);
    deliver(w, [u8(43), chunks[1]!]);
    deliver(w, [u8(42), long(1000)]); // silence is not forwarded while off
    deliver(w, [u8(12, 0), unicode('marker')]); // everything above has been consumed once this arrives
    await waitFor(() => chatEvents(w).length === 1);
    await w.session.setComputerAudio(true);
    deliver(w, [u8(42), long(16)]);
    deliver(w, [u8(43), chunks[2]!]);
    await waitFor(() => audioEvents(w).length === 3);
    const [first, silence, last] = audioEvents(w);
    expect(first).toEqual(expected.subarray(0, cut * 2));
    expect(silence).toEqual(new Int16Array(8));
    expect(last).toEqual(expected.subarray(4 * cut));
    expect(w.closedEvent()).toBeUndefined();
    w.session.close();
  });

  test('audio: 42/43 outside active, malformed and oversized packets are dropped', async () => {
    const w = await activeWorld();
    await w.session.setComputerAudio(true);
    deliver(w, [u8(42)]); // no body
    deliver(w, [u8(42), u8(1, 2)]); // short count
    deliver(w, [u8(42), long(262_145)]); // over the limit
    deliver(w, [u8(42), long(-4)]);
    deliver(w, [u8(43), new Uint8Array(64 * 1024 + 1)]);
    deliver(w, [u8(42), long(0)]);
    await waitFor(() => audioEvents(w).length === 1);
    expect(audioEvents(w)).toEqual([new Int16Array(0)]);
    expect(w.closedEvent()).toBeUndefined();
    expect(w.statuses().some((s) => /^ignored (42|43)$/.test(s))).toBe(false);
    // During a screen refresh the phase is login: audio is not forwarded (the fake host stays silent).
    w.o.initParts = null;
    await w.session.refreshScreen();
    deliver(w, [u8(42), long(8)]);
    deliver(w, [u8(12, 0), unicode('marker')]);
    await waitFor(() => chatEvents(w).length === 1);
    expect(audioEvents(w)).toHaveLength(1);
    w.session.close();
  });

  test('audio: decoder is created lazily on the first 43, packets queued during load keep order, disposed on close', async () => {
    let release!: (d: PcmDecoder) => void;
    let created = 0;
    const decoded: number[] = [];
    let disposed = 0;
    const fake: PcmDecoder = {
      decode: (e) => {
        decoded.push(e[0]!);
        return Int16Array.of(e[0]!, -e[0]!);
      },
      dispose: () => void disposed++,
    };
    const w = await activeWorld({
      deps: { makeG722Decoder: () => (created++, new Promise<PcmDecoder>((r) => { release = r; })) },
    });
    await w.session.setComputerAudio(true);
    deliver(w, [u8(42), long(4)]);
    await waitFor(() => audioEvents(w).length === 1);
    expect(created).toBe(0); // silence does not need the decoder
    deliver(w, [u8(43), u8(1)]);
    deliver(w, [u8(43), u8(2)]);
    deliver(w, [u8(43), u8(3)]);
    await waitFor(() => created === 1);
    deliver(w, [u8(12, 0), unicode('marker')]);
    await waitFor(() => chatEvents(w).length === 1);
    expect(decoded).toEqual([]);
    release(fake);
    await waitFor(() => audioEvents(w).length === 4);
    expect(decoded).toEqual([1, 2, 3]);
    expect(audioEvents(w).slice(1)).toEqual([Int16Array.of(1, -1), Int16Array.of(2, -2), Int16Array.of(3, -3)]);
    deliver(w, [u8(43), u8(4)]);
    await waitFor(() => audioEvents(w).length === 5);
    expect(created).toBe(1);
    expect(disposed).toBe(0);
    w.session.close();
    expect(disposed).toBe(1);
  });

  test('audio: packets that arrive while the decoder loads are capped at the newest 250 ms (12,000 bytes)', async () => {
    let release!: (d: PcmDecoder) => void;
    const decoded: number[] = [];
    const fake: PcmDecoder = { decode: (e) => (decoded.push(e.length), new Int16Array(e.length * 2)), dispose: () => {} };
    const w = await activeWorld({ deps: { makeG722Decoder: () => new Promise<PcmDecoder>((r) => { release = r; }) } });
    await w.session.setComputerAudio(true);
    for (const size of [5000, 5000, 5000, 5000]) deliver(w, [u8(43), new Uint8Array(size).fill(1)]);
    deliver(w, [u8(12, 0), unicode('marker')]);
    await waitFor(() => chatEvents(w).length === 1);
    release(fake);
    await waitFor(() => audioEvents(w).length === 2);
    expect(decoded).toEqual([5000, 5000]); // oldest two dropped: 10,000 <= 12,000 < 15,000
    w.session.close();
  });

  test('audio: a decoder created after the session closed is disposed at once', async () => {
    let release!: (d: PcmDecoder) => void;
    let disposed = 0;
    const w = await activeWorld({ deps: { makeG722Decoder: () => new Promise<PcmDecoder>((r) => { release = r; }) } });
    await w.session.setComputerAudio(true);
    deliver(w, [u8(43), u8(1)]);
    await waitFor(() => typeof release === 'function');
    w.session.close();
    release({ decode: () => new Int16Array(2), dispose: () => void disposed++ });
    await waitFor(() => disposed === 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(audioEvents(w)).toEqual([]);
  });

  test('audio: a decoder that fails to load is logged once, audio is dropped, the session stays up', async () => {
    let calls = 0;
    const w = await activeWorld({ deps: { makeG722Decoder: () => (calls++, Promise.reject(new Error('wasm bad'))) } });
    await w.session.setComputerAudio(true);
    deliver(w, [u8(43), u8(1)]);
    await waitFor(() => w.statuses().some((s) => s.startsWith('Không tải được bộ giải mã âm thanh')));
    deliver(w, [u8(43), u8(2)]);
    deliver(w, [u8(42), long(4)]); // silence still flows
    deliver(w, [u8(12, 0), unicode('marker')]);
    await waitFor(() => chatEvents(w).length === 1);
    expect(calls).toBe(1);
    expect(w.statuses().filter((s) => s.startsWith('Không tải được bộ giải mã âm thanh'))).toHaveLength(1);
    expect(audioEvents(w)).toEqual([new Int16Array(2)]);
    expect(w.closedEvent()).toBeUndefined();
    w.session.close();
  });

  test('secrecy: chat, clipboard text and audio never reach a status string', async () => {
    const w = await activeWorld();
    w.session.setClipboardSharing(true);
    await w.session.sendChat('SENTINELCHATOUT');
    await w.session.sendClipboard('SENTINELCLIPOUT');
    deliver(w, [u8(12, 0), unicode('SENTINELCHATIN')]);
    const utf16 = unicode('SENTINELCLIPIN');
    deliver(w, [u8(33), long(utf16.length), rawZstdFrame(utf16)]);
    await waitFor(() => clipboardEvents(w).length === 1 && chatEvents(w).length === 1);
    const log = w.statuses().join('\n');
    for (const secret of ['SENTINELCHATOUT', 'SENTINELCLIPOUT', 'SENTINELCHATIN', 'SENTINELCLIPIN']) expect(log).not.toContain(secret);
    expect(log).toContain('nhận tin nhắn chat');
    w.session.close();
  });
  // Phase 2 Task 4: file transfer routing (13-16/21) on top of the engine (file-engine.test.ts).
  describe('file transfer', () => {
    const fileEvents = (w: World) => w.events.flatMap((e) => (e.type === 'file' ? [e.event] : []));
    const dbl = (n: number) => {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setFloat64(0, n, true);
      return out;
    };
    const offerParts = (id: string, name: string, size: number) => [u8(13, 0), enc(id), enc(name), dbl(size)];
    const chunkParts = (id: string, offset: number, data: Uint8Array) => [u8(15, 0), enc(id), dbl(offset), data];
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    class Sink implements FileSink {
      chunks: Uint8Array[] = [];
      closed = false;
      aborted = false;
      async write(c: Uint8Array) {
        this.chunks.push(c);
      }
      async close() {
        this.closed = true;
      }
      async abort() {
        this.aborted = true;
      }
    }
    const memorySource = (bytes: Uint8Array): FileSource => ({ size: bytes.length, read: async (o, l) => bytes.slice(o, o + l) });

    test('receive: offer, accept ("14|||id|||1"), chunk, per-chunk ack "21|||id", completed', async () => {
      const w = await activeWorld();
      deliver(w, offerParts('123', 'a.txt', 3));
      await waitFor(() => fileEvents(w).length === 1);
      expect(fileEvents(w)[0]).toEqual({ type: 'incoming', id: '123', name: 'a.txt', size: 3 });
      const sink = new Sink();
      await w.session.acceptFile('123', sink);
      expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('14|||123|||1') });
      deliver(w, chunkParts('123', 1, u8(1, 2, 3)));
      await waitFor(() => fileEvents(w).some((e) => e.type === 'completed'));
      expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('21|||123') });
      expect(concat(...sink.chunks)).toEqual(u8(1, 2, 3));
      expect(sink.closed).toBe(true);
      w.session.close();
    });

    test('send: offer "13|||id|||name|||size", host accept, raw chunks (flag false), ack, completed', async () => {
      const w = await activeWorld();
      const bytes = Uint8Array.from({ length: 40_000 }, (_, i) => i & 255);
      const id = w.session.sendFile('báo cáo.bin', memorySource(bytes));
      await waitFor(() => w.peerForwards.some((f) => text16(f.payload).startsWith('13|||')));
      const offer = w.peerForwards.find((f) => text16(f.payload).startsWith('13|||'))!;
      expect(offer.formatFlag).toBe(true);
      expect(text16(offer.payload)).toBe(`13|||${id}|||báo cáo.bin|||40000`);
      deliver(w, [u8(14, 0), enc(id), u8(1, 0, 0, 0)]);
      await waitFor(() => w.peerForwards.filter((f) => !f.formatFlag && text(f.payload).startsWith('15|||')).length === 2);
      const raw = w.peerForwards.filter((f) => !f.formatFlag && text(f.payload).startsWith('15|||'));
      expect(text(raw[0]!.payload.subarray(0, `15|||${id}|||1|||`.length))).toBe(`15|||${id}|||1|||`);
      expect(text(raw[1]!.payload.subarray(0, `15|||${id}|||32001|||`.length))).toBe(`15|||${id}|||32001|||`);
      deliver(w, [u8(21, 0), enc(id)]);
      deliver(w, [u8(21, 0), enc(id)]);
      await waitFor(() => fileEvents(w).some((e) => e.type === 'completed'));
      w.session.close();
    });
    const text16 = (b: Uint8Array) => new TextDecoder('utf-16le').decode(b);

    test('the tool gate: sendFile/acceptFile reject before accepted, and incoming file messages are dropped', async () => {
      const w = new World({ initParts: null, sendFrameAfter17: false });
      w.connect();
      await waitFor(() => w.peerTexts.some((t) => t.startsWith('login:')));
      expect(() => w.session.sendFile('a', memorySource(u8(1)))).toThrowError(expect.objectContaining({ code: 'toolsUnavailable' }));
      await expect(w.session.acceptFile('1', new Sink())).rejects.toMatchObject({ code: 'toolsUnavailable' });
      deliver(w, offerParts('1', 'a', 1));
      await flush();
      expect(fileEvents(w)).toEqual([]);
      w.session.close();
    });

    test('file transfer does not depend on the control permission (49 view-only)', async () => {
      const w = await activeWorld();
      deliver(w, [u8(49), u8(1)]);
      deliver(w, offerParts('7', 'a', 1));
      await waitFor(() => fileEvents(w).length === 1);
      expect(fileEvents(w)[0]).toMatchObject({ type: 'incoming', id: '7' });
      w.session.close();
    });

    test('malformed file messages are dropped; a duplicate offer is ignored; cancel from the host', async () => {
      const w = await activeWorld();
      deliver(w, [u8(13, 0), enc('1'), enc('a|||b'), dbl(1)]);
      deliver(w, [u8(15, 0), enc('1'), dbl(0), u8(1)]);
      deliver(w, offerParts('2', 'a', 3));
      deliver(w, offerParts('2', 'a', 3));
      await waitFor(() => fileEvents(w).length >= 1);
      await flush();
      expect(fileEvents(w)).toHaveLength(1);
      const sink = new Sink();
      await w.session.acceptFile('2', sink);
      deliver(w, [u8(16, 0), enc('2')]);
      await waitFor(() => fileEvents(w).some((e) => e.type === 'canceled'));
      expect(sink.aborted).toBe(true);
      w.session.close();
    });

    test('cancelFile tells the host ("16|||id") and a disconnect aborts every transfer before `closed`', async () => {
      const w = await activeWorld();
      deliver(w, offerParts('1', 'a', 100));
      deliver(w, offerParts('2', 'b', 100));
      await waitFor(() => fileEvents(w).length === 2);
      const sink = new Sink();
      await w.session.acceptFile('2', sink);
      await w.session.cancelFile('1');
      expect(w.peerForwards.at(-1)).toEqual({ formatFlag: true, payload: unicode('16|||1') });
      const sent = w.peerForwards.length;
      w.session.close();
      expect(sink.aborted).toBe(true);
      expect(sink.closed).toBe(false);
      const events = w.events;
      const canceledAt = events.findIndex((e) => e.type === 'file' && e.event.type === 'canceled' && e.event.id === '2');
      expect(canceledAt).toBeGreaterThan(-1);
      expect(canceledAt).toBeLessThan(events.findIndex((e) => e.type === 'closed'));
      await expect(w.session.cancelFile('2')).resolves.toBeUndefined();
      await flush();
      expect(w.peerForwards.slice(sent).filter((f) => text16(f.payload).startsWith('16|||'))).toEqual([]);
    });

    test('secrecy: file names and contents never reach a status string', async () => {
      const w = await activeWorld();
      deliver(w, offerParts('1', 'SENTINELFILENAME.txt', 3));
      await waitFor(() => fileEvents(w).length === 1);
      await w.session.acceptFile('1', new Sink());
      deliver(w, chunkParts('1', 1, enc('SEN')));
      await waitFor(() => fileEvents(w).some((e) => e.type === 'completed'));
      expect(w.statuses().join('\n')).not.toContain('SENTINELFILENAME');
      w.session.close();
    });
  });
});
