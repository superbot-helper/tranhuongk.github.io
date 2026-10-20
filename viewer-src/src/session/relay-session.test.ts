// RelaySession against in-memory fake relays (command + peer). Replies are built from the
// Task 5 message vectors (registration "3:" / lookup "8:") and the Task 6 screen fixtures.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PipeError } from '../net/pipe';
import { TlsError, type ByteChannel } from '../net/tls';
import { commandCipher, md5Hex } from '../proto/crypto';
import { decodeEnvelope, encodeEnvelope, encodeSystem, keepaliveCommandEnvelope, PreambleDecoder } from '../proto/envelope';
import { encodeFrame, FrameDecoder } from '../proto/frame';
import { decodeMultipart, encodeMultipart } from '../proto/multipart';
import { screenLong, screenParts, screenWords } from '../proto/screen-test-utils';
import { concat, enc, u8 } from '../proto/test-utils';
import type { ClientIdentity } from './identity';
import { RelaySession, type SessionEvent } from './relay-session';

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
  openChannel?: (ip: string, certName: string) => Promise<ByteChannel>;
  ips?: string[];
}

class World {
  readonly opens: { ip: string; certName: string }[] = [];
  readonly channels: FakeChannel[] = [];
  readonly events: SessionEvent[] = [];
  readonly commandTexts: string[] = [];
  readonly peerTexts: string[] = [];
  readonly peerSystem: string[] = [];
  readonly session: RelaySession;

  constructor(readonly o: WorldOptions = {}) {
    this.session = new RelaySession({
      openChannel: (ip, certName) => {
        this.opens.push({ ip, certName });
        if (o.openChannel) return o.openChannel(ip, certName);
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
    expect(w.peerTexts.slice(1)).toEqual(['17', '18']);

    const accepted = w.events.find((e) => e.type === 'accepted');
    expect(accepted).toEqual({
      type: 'accepted',
      peer: { displayName: 'Name', version: '6.6.133', width: 2, height: 1, virtualLeft: 0, virtualTop: 0 },
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

  test('silent relay while active (no bytes for 18 s after pongs were seen) → closed(transportClosed) ≤ 20 s', async () => {
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
    expect(w.peerTexts.slice(1, 3)).toEqual(['17', '18']);
    const refresh = w.peerTexts.filter((t) => t.startsWith('login:'))[1]!.split(':');
    expect(refresh[12]).toBe('0'); // clearControlMode
    // The refreshed initialization returns the session to active.
    await waitFor(() => w.session.phase === 'active' && w.peerTexts.filter((t) => t === '17').length === 2);
    expect(w.closedEvent()).toBeUndefined();
    expect(w.statuses().join('\n')).toContain('sequenceMismatch');
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
    w.peer!.deliver(fromPartner(encodeMultipart([u8(28), u8(1, 2, 3)])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(28), u8(4)])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(27)])));
    w.peer!.deliver(fromPartner(encodeMultipart([u8(1)]), '192.0.2.200', 1));
    await waitFor(() => w.session.diagnostics.ignoredSources === 1);
    const ignored = w.statuses().filter((s) => s.startsWith('ignored'));
    expect(ignored).toEqual(['ignored 28', 'ignored 27']);
    expect(w.session.diagnostics.ignoredMessages).toBe(3);
    expect(w.closedEvent()).toBeUndefined();
  });

  test('command IPs are tried in order, 3 s each; a late connection is closed', async () => {
    useFakeClock();
    let late: (ch: ByteChannel) => void = () => {};
    const lateChannel = new FakeChannel('192.0.2.4', COMMAND_HOST);
    const w: World = new World({
      ips: ['192.0.2.1', '192.0.2.4', '192.0.2.9'],
      openChannel: (ip, certName) => {
        if (ip === '192.0.2.1') return Promise.reject(new TlsError('handshake', 'reset'));
        if (ip === '192.0.2.4') return new Promise((resolve) => (late = resolve));
        return Promise.resolve(w.relay(ip, certName));
      },
    });
    w.connect();
    await settle(() => w.opens.length === 2);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(w.opens).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle(() => w.opens.length >= 3);
    const commandOpens = w.opens.slice(0, 3);
    expect(commandOpens.map((o) => o.ip)).toEqual(['192.0.2.1', '192.0.2.4', '192.0.2.9']);
    expect(commandOpens.every((o) => o.certName === COMMAND_HOST)).toBe(true);
    late(lateChannel);
    await settle(() => lateChannel.closed);
    await settle(() => w.commandTexts.length >= 1);
    expect(w.command!.ip).toBe('192.0.2.9');
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
