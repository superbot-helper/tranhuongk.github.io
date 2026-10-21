// Port of the relay (controller) path of UltraViewerProtocol/UltraViewerRelaySession.swift:
// begin (299-321), consumeCommand (323-364), beginPeer (576-604), login (606-636),
// consumePeer / consumeApplication cases 0 and 1 (638-830), sendToPeer (861-874),
// armDeadline (876-885), sendHeartbeat (887-920), finish.
//
// Phase 0 scope: registering -> lookup -> login -> active (initialization + screen frames,
// tile-size change 48), partner end/block (27/41/54, 39), heartbeats, deadline and close
// handling. Phase 1 adds the control API (send 217-224, sendCommand 261-265, refreshScreen
// 226-238), cursor 3/4/28 (716-718), host re-login 23 (828-832) and input permission 49
// (848-853); pure helpers live in ./control. No LAN direct, files, chat, clipboard or audio:
// every other application id (including 26, no relay retargeting) is logged once as
// `ignored <id>` and dropped.
//
// Web additions (no Swift equivalent): the command host is resolved over DoH and its IPv4
// addresses are tried in order (RelayCommandConnection, 3 s each); a liveness watchdog
// closes an active session when a ping stays unanswered (no inbound byte at all) for 8 s,
// once the relay has proven it answers pings (phone lock / dropped WebSocket without a
// close event). It never judges across a timer-throttling gap: a late tick sends a fresh
// ping and starts the 8 s window from then.
//
// Secrets: the partner password, its MD5 proofs, the client password and the Worker token
// never appear in a status string or an error detail.
import { DnsError } from '../net/dns';
import { PipeError } from '../net/pipe';
import { TlsError, type ByteChannel } from '../net/tls';
import { loadScreenDictionary } from '../codec/screen-dictionary';
import { commandPayload, type RemoteCommand, type RemoteMonitor } from '../proto/commands';
import { makeCursorZstd, type CursorEvent, type CursorZstd } from '../proto/cursor';
import { CLIENT_VERSION, LOGIN_DEFAULTS, LOOKUP_DEFAULTS, makeRegistrationRequest } from '../proto/client-defaults';
import { commandCipher } from '../proto/crypto';
import {
  decodeEnvelope, encodeEnvelope, encodeSystem, httpPreamble, keepaliveCommandEnvelope, keepaliveRelayEnvelope,
  parseIPv4, PreambleDecoder,
} from '../proto/envelope';
import { encodeFrame, FrameDecoder } from '../proto/frame';
import { loginBytes } from '../proto/login';
import { lookupBytes, parseLookupReply, type PeerInfo } from '../proto/lookup';
import { decodeMultipart } from '../proto/multipart';
import { parseRegistrationReply, registrationEnvelope, type RegistrationReply } from '../proto/registration';
import { decodeFrameMessage, decodeInitialization, ModernScreenMessageError } from '../proto/screen-message';
import { ModernScreenRenderer, type JpegDecoder, type ScreenBitmap } from '../proto/screen-renderer';
import { BINARY_KEYBOARD_VERSION, decodeCursor, initMonitors, versionAtLeast, viewOnlyFlag } from './control';
import type { ClientIdentity } from './identity';

export { versionAtLeast } from './control';

export const COMMAND_HOST = 'functions3.ultraviewer.net';
const SNI = 'ultraviewer';
/**
 * Per-address command attempt. Swift RelayCommandConnection uses 3 s over native TCP; the web
 * path adds DNS + TLS to Cloudflare + WS upgrade + Durable Object lease + TCP to the relay +
 * 2-RTT forge TLS (often on 4G), so 3 s abandons healthy attempts. The 20 s phase deadline
 * still bounds the whole registration phase.
 */
export const COMMAND_ATTEMPT_MS = 8_000;
/** FramedTCPTransport.open default timeout (data connection). */
export const PEER_CONNECT_MS = 10_000;
/** armDeadline: 20 s per handshake phase. */
export const PHASE_DEADLINE_MS = 20_000;
export const HEARTBEAT_MS = 10_000;
/** frmMain.tmPingServer: the command keepalive goes out every 6th heartbeat (60 s). */
const COMMAND_KEEPALIVE_EVERY = 6;
/** Web watchdog: a ping with no inbound byte since it was sent for this long = dead. */
export const PROBE_TIMEOUT_MS = 8_000;
const WATCHDOG_TICK_MS = 1_000;
/** A watchdog tick this late means timers were throttled (hidden tab): re-probe, do not judge. */
const LATE_TICK_MS = 3_000;

export interface Peer {
  /** Base64-decoded lookup field 8, when it decodes as UTF-8. */
  displayName: string | null;
  version: string;
  width: number;
  height: number;
  virtualLeft: number;
  virtualTop: number;
  /** Version >= 6.2.13: binary keyboard packets are understood. */
  supportsBinaryKeyboard: boolean;
  /** False when the host announced view-only (49 flag != 0) before this initialization. */
  allowsRemoteInput: boolean;
  /** Init part 8; [] when absent or malformed (logged once). */
  monitors: RemoteMonitor[];
}

/**
 * `protocol` (not in the plan's list): malformed data from the relay or the partner
 * (Swift: parse errors, malformedInitialization, an unrecoverable screen error).
 */
export type SessionFailure =
  | 'wrongPassword' | 'lookupRejected' | 'invalidLookupRoute' | 'unsupportedVersion' | 'deadline'
  | 'transportClosed' | 'tls' | 'workerRefused' | 'protocol'
  /** Commands 27/41/54: the Windows side ended the session (Swift Failure.closed). */
  | 'partnerEnded'
  /** Command 39: the Windows side blocked this connection (Swift Failure.partnerBlocked). */
  | 'partnerBlocked';

export type SessionEvent =
  | { type: 'status'; text: string }
  | { type: 'accepted'; peer: Peer }
  /** The renderer's live bitmap: draw it (or snapshot it) before the next frame is decoded. */
  | { type: 'frame'; bitmap: ScreenBitmap }
  /** Command 49 while active, and `false` when a screen refresh suspends control. */
  | { type: 'inputPermission'; allowed: boolean }
  /** Commands 3/4/28 while active. A `select` of an unknown hash: send(cursorShapeRequest(hash)). */
  | { type: 'cursor'; event: CursorEvent }
  | { type: 'closed'; reason: SessionFailure | null };

export type SessionPhase = 'closed' | 'registering' | 'lookup' | 'login' | 'active';

export interface RelaySessionDeps {
  /**
   * A TLS channel (SNI "ultraviewer", certificate checked against `certName`) to `ip`:443.
   * `signal` fires only when the session abandons this attempt (timeout): the opener must
   * then close whatever it opened (Worker lease).
   */
  openChannel(ip: string, certName: string, signal?: AbortSignal): Promise<ByteChannel>;
  resolve(host: string): Promise<string[]>;
  /** Milliseconds, monotonic enough for durations. */
  now(): number;
  /** Defaults to the bundled 8bit.dat (pinned SHA-256). */
  loadDictionary?: () => Promise<Uint8Array | null>;
  /** Defaults to the browser JPEG decoder. */
  decodeJpeg?: JpegDecoder;
  /** Defaults to a dictionary-free zstd decoder for cursor shapes (created on the first command 4). */
  makeCursorZstd?: () => Promise<CursorZstd>;
}

export interface ConnectOptions {
  identity: ClientIdentity;
  partnerID: string;
  password: string;
  /** Local screen in device pixels (login fields 3/4). */
  screenW: number;
  screenH: number;
  displayName: string;
}

export interface SessionDiagnostics {
  registrationAccepted: boolean;
  assignedID: string | null;
  lookupStatus: number | null;
  peerTransportOpened: boolean;
  loginSent: boolean;
  peerAccepted: boolean;
  decodedFrames: number;
  decodeMsTotal: number;
  decodeMsMax: number;
  screenPayloadBytes: number;
  screenRefreshes: number;
  lastScreenFailure: string | null;
  relayKeepalivesSent: number;
  commandKeepalivesSent: number;
  relayPongs: number;
  relayRttMs: number | null;
  peerRttMs: number | null;
  ignoredMessages: number;
  ignoredSources: number;
}

function freshDiagnostics(): SessionDiagnostics {
  return {
    registrationAccepted: false, assignedID: null, lookupStatus: null, peerTransportOpened: false,
    loginSent: false, peerAccepted: false, decodedFrames: 0, decodeMsTotal: 0, decodeMsMax: 0,
    screenPayloadBytes: 0, screenRefreshes: 0, lastScreenFailure: null, relayKeepalivesSent: 0,
    commandKeepalivesSent: 0, relayPongs: 0, relayRttMs: null, peerRttMs: null, ignoredMessages: 0,
    ignoredSources: 0,
  };
}

/** Swift Failure cases thrown by the public API (connect / send / sendCommand / refreshScreen). */
export class RelaySessionError extends Error {
  readonly code: 'alreadyOpen' | 'invalidPartner' | 'notConnected' | 'viewOnly';
  constructor(code: RelaySessionError['code']) {
    super(code);
    this.name = 'RelaySessionError';
    this.code = code;
  }
}

/** A session-ending condition with the reason the page shows. `detail` is secret-free. */
class Failure extends Error {
  constructor(readonly reason: SessionFailure, readonly detail: string) {
    super(detail);
    this.name = 'Failure';
  }
}

class AttemptTimeout extends Error {
  constructor(ms: number) {
    super(`no TLS connection within ${ms / 1000} s`);
    this.name = 'AttemptTimeout';
  }
}

const WORKER_CODES: Record<number, string> = {
  4401: 'token sai',
  4403: 'đích bị Worker cấm',
  4429: 'quá nhiều kết nối',
  4502: 'Worker không mở được TCP',
};

/** The Worker close code behind a refused pipe (PipeError, or TlsError carrying the pipe reason). */
function workerCode(e: unknown): number | null {
  if (e instanceof PipeError) return e.closeCode in WORKER_CODES ? e.closeCode : null;
  if (e instanceof TlsError && e.code === 'closed') {
    const m = /\b(4401|4403|4429|4502)\b/.exec(e.message);
    return m ? Number(m[1]) : null;
  }
  return null;
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return `${e.name}${typeof code === 'string' ? `(${code})` : ''}: ${e.message}`;
  }
  return String(e);
}

/** Maps any thrown value to the page-level reason. Messages of these errors carry no secrets. */
function classify(e: unknown): Failure {
  if (e instanceof Failure) return e;
  const code = workerCode(e);
  if (code !== null) return new Failure('workerRefused', `Worker từ chối (${code}: ${WORKER_CODES[code]})`);
  if (e instanceof TlsError) {
    if (e.code === 'closed') return new Failure('transportClosed', `kết nối đóng trước khi TLS xong: ${e.message}`);
    return new Failure('tls', `TLS lỗi (${e.code}): ${e.message}`);
  }
  if (e instanceof PipeError) {
    if (e.code === 'invalidToken') return new Failure('workerRefused', 'token Worker sai định dạng (cần ≥ 16 ký tự A-Z, a-z, 0-9, _ hoặc -)');
    if (e.code === 'cannotOpen') return new Failure('transportClosed', 'không tạo được WebSocket tới Worker (kiểm tra Worker URL)');
    if (e.code === 'aborted') return new Failure('transportClosed', 'bỏ lần thử kết nối');
    return new Failure('transportClosed', `Worker pipe đóng (${e.closeCode})`);
  }
  if (e instanceof AttemptTimeout) return new Failure('transportClosed', e.message);
  if (e instanceof DnsError) return new Failure('transportClosed', `DNS lỗi: ${describe(e)}`);
  return new Failure('protocol', `dữ liệu không hợp lệ: ${describe(e)}`);
}

/**
 * Errors out of `openChannel` other than the transport's own typed ones may quote the token
 * (e.g. a browser `SyntaxError: The subprotocol '<token>' is invalid.`): keep only the name.
 */
function transportError(e: unknown): unknown {
  if (e instanceof Failure || e instanceof PipeError || e instanceof TlsError || e instanceof AttemptTimeout || e instanceof DnsError) {
    return e;
  }
  const name = e instanceof Error ? e.name : typeof e;
  return new Failure('transportClosed', `mở kết nối lỗi (${name})`);
}

/** At most this many distinct foreign sources are logged (the counter keeps counting). */
const MAX_LOGGED_FOREIGN_SOURCES = 32;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ASCII = new TextEncoder();
const HASH_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomString(count: number, alphabet: string): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < count) {
    for (const byte of crypto.getRandomValues(new Uint8Array(count * 2))) {
      if (byte < limit && out.length < count) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

/** Int32.random(in: 1...Int32.max) */
function randomCorrelation(): number {
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff;
    if (value !== 0) return value;
  }
}

function decodeComputerName(field: string): string | null {
  try {
    const binary = atob(field);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix.charCodeAt(i)) return false;
  return true;
}

function equalsAscii(bytes: Uint8Array, s: string): boolean {
  return bytes.length === s.length && startsWith(bytes, s);
}

/** One relay connection: HTTP preamble out, response header stripped, length-prefixed frames in. */
class FramedChannel {
  private readonly preamble = new PreambleDecoder();
  private readonly framer = new FrameDecoder();

  constructor(readonly channel: ByteChannel, readonly ip: string) {}

  start(host: string, onFrame: (frame: Uint8Array) => void, onError: (e: unknown) => void, onBytes?: () => void): void {
    this.channel.onData((chunk) => {
      onBytes?.();
      let frames: Uint8Array[];
      try {
        frames = this.framer.push(this.preamble.push(chunk));
      } catch (e) {
        onError(e);
        return;
      }
      for (const frame of frames) onFrame(frame);
    });
    this.channel.send(httpPreamble(host));
  }

  send(payload: Uint8Array): void {
    this.channel.send(encodeFrame(payload));
  }

  get expired(): boolean | null {
    const expired = (this.channel as { expired?: unknown }).expired;
    return typeof expired === 'boolean' ? expired : null;
  }
}

export class RelaySession {
  private state: SessionPhase = 'closed';
  private generation = 0;
  private on: (e: SessionEvent) => void = () => {};
  private options: ConnectOptions | null = null;
  private command: FramedChannel | null = null;
  private peer: FramedChannel | null = null;
  private commandQueue: Promise<void> = Promise.resolve();
  private peerQueue: Promise<void> = Promise.resolve();
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private heartbeatTicks = 0;
  private lastInboundAt = 0;
  /** When the outstanding liveness ping went out; null when answered (any inbound byte since). */
  private probeSentAt: number | null = null;
  private lastWatchdogTickAt = 0;
  private relayAnswersPings = false;
  private relayPingStarted: number | null = null;
  private peerPingStarted: number | null = null;
  private registration: RegistrationReply | null = null;
  private peerInfo: PeerInfo | null = null;
  private targetAddress = '';
  private targetPort = 0;
  private password = '';
  private connectionHash = '';
  private correlation = 0;
  private renderer: ModernScreenRenderer | null = null;
  private dictionary: Promise<Uint8Array | null> | null = null;
  private cursorZstd: Promise<CursorZstd> | null = null;
  /** Swift remoteViewOnly: the last command 49 flag (any phase); reset per connection. */
  private remoteViewOnly = false;
  private monitorErrorLogged = false;
  /** Screen refreshes caused by undecodable frames since the last good frame (manual refreshes are not counted). */
  private decodeErrorRefreshes = 0;
  private readonly ignoredIDs = new Set<number>();
  private readonly foreignSources = new Set<string>();
  private diag: SessionDiagnostics = freshDiagnostics();

  constructor(private readonly deps: RelaySessionDeps) {}

  get phase(): SessionPhase {
    return this.state;
  }

  get diagnostics(): Readonly<SessionDiagnostics> {
    return this.diag;
  }

  connect(o: ConnectOptions, on: (e: SessionEvent) => void): void {
    if (this.state !== 'closed') throw new RelaySessionError('alreadyOpen');
    if (!/^[0-9]{1,64}$/.test(o.partnerID) || o.password.length === 0 || !/^[\x00-\x7f]*$/.test(o.password)) {
      throw new RelaySessionError('invalidPartner');
    }
    const gen = ++this.generation;
    this.on = on;
    this.options = o;
    this.password = o.password;
    this.connectionHash = randomString(16, HASH_ALPHABET);
    this.correlation = randomCorrelation();
    this.diag = freshDiagnostics();
    this.ignoredIDs.clear();
    this.foreignSources.clear();
    this.heartbeatTicks = 0;
    this.remoteViewOnly = false;
    this.monitorErrorLogged = false;
    this.relayAnswersPings = false;
    this.relayPingStarted = null;
    this.peerPingStarted = null;
    this.commandQueue = Promise.resolve();
    this.peerQueue = Promise.resolve();
    this.state = 'registering';
    void this.begin(gen).catch((e: unknown) => this.fail(e, gen));
  }

  /**
   * Swift send(_:): raw application payload (input packets, cursorShapeRequest). Allowed once
   * accepted while active or during an authenticated re-login/refresh, so held input can still
   * be released after control was suspended.
   */
  async send(bytes: Uint8Array, formatFlag = false): Promise<void> {
    if (!this.diag.peerAccepted || (this.state !== 'active' && this.state !== 'login') || this.peer === null) {
      throw new RelaySessionError('notConnected');
    }
    this.sendToPeer(bytes, formatFlag);
  }

  /** Swift sendCommand: active only; `requiresControl` commands are refused while view-only. */
  async sendCommand(c: RemoteCommand, opts: { requiresControl: boolean }): Promise<void> {
    if (this.state !== 'active' || this.peer === null) throw new RelaySessionError('notConnected');
    if (opts.requiresControl && this.remoteViewOnly) throw new RelaySessionError('viewOnly');
    for (const m of commandPayload(c)) this.sendToPeer(m.bytes, m.formatFlag);
  }

  /** Swift refreshScreen: renegotiate a complete screen; control is suspended until the init. */
  async refreshScreen(): Promise<void> {
    if (this.state !== 'active') throw new RelaySessionError('notConnected');
    this.renegotiateScreen(this.generation);
  }

  /** Tells an active host that this viewer is leaving ("19", RemoteControlCommands.endSession), then closes. */
  close(): void {
    if (this.state === 'active') this.sendToPeer(ASCII.encode('19'));
    this.finish(null);
  }

  // MARK: - command connection

  private live(gen: number): boolean {
    return gen === this.generation && this.state !== 'closed';
  }

  private status(text: string): void {
    this.on({ type: 'status', text });
  }

  private async begin(gen: number): Promise<void> {
    this.status('Đăng ký với máy chủ UltraViewer…');
    this.armDeadline(gen);
    const ips = await this.resolveHost(COMMAND_HOST);
    if (!this.live(gen)) return;
    this.status(`DNS ${COMMAND_HOST}: ${ips.join(', ') || '(không có A record)'}`);
    if (ips.length === 0) throw new Failure('transportClosed', `không có địa chỉ IPv4 cho ${COMMAND_HOST}`);
    const opened = await this.openFirst(ips, COMMAND_HOST, COMMAND_ATTEMPT_MS, gen, 'command');
    if (!opened) return;
    this.command = opened;
    opened.channel.onClose((reason) => this.fail(new Failure('transportClosed', `kết nối command đóng: ${reason}`), gen));
    opened.start(
      COMMAND_HOST,
      (frame) => {
        this.commandQueue = this.commandQueue
          .then(() => (this.live(gen) ? this.consumeCommand(frame, gen) : undefined))
          .catch((e: unknown) => this.fail(e, gen));
      },
      (e) => this.fail(e, gen),
    );
    this.armDeadline(gen);
    const request = makeRegistrationRequest(this.options!.identity);
    opened.send(registrationEnvelope(request, commandCipher));
    this.status('Đã gửi đăng ký (lệnh 3)');
  }

  private async resolveHost(host: string): Promise<string[]> {
    return IPV4.test(host) ? [host] : this.deps.resolve(host);
  }

  /** RelayCommandConnection.openCandidates: each address in order with its own timeout. */
  private async openFirst(
    ips: string[], certName: string, timeoutMs: number, gen: number, label: string,
  ): Promise<FramedChannel | null> {
    let lastError: unknown = null;
    for (const ip of ips) {
      if (!this.live(gen)) return null;
      this.status(`${label}: WS + TLS tới ${ip} (cert ${certName})…`);
      try {
        const channel = await this.withTimeout((signal) => this.deps.openChannel(ip, certName, signal), timeoutMs);
        if (!this.live(gen)) {
          channel.close();
          return null;
        }
        const framed = new FramedChannel(channel, ip);
        const expired = framed.expired;
        this.status(`${label}: TLS OK ${ip}${expired === null ? '' : ` (cert expired: ${expired})`}`);
        return framed;
      } catch (raw) {
        if (!this.live(gen)) return null;
        const e = transportError(raw);
        lastError = e;
        this.status(`${label}: ${ip} thất bại: ${classify(e).detail}`);
      }
    }
    throw lastError ?? new Failure('transportClosed', `không có địa chỉ cho ${certName}`);
  }

  /**
   * Rejects after `ms` and aborts the attempt's signal, so the opener closes its pipe (and the
   * Worker lease) at once; a channel that still opens later is closed instead of leaking.
   * The signal is never aborted once the channel has been handed out.
   */
  private withTimeout(open: (signal: AbortSignal) => Promise<ByteChannel>, ms: number): Promise<ByteChannel> {
    const controller = new AbortController();
    let p: Promise<ByteChannel>;
    try {
      p = open(controller.signal);
    } catch (e) {
      p = Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        reject(new AttemptTimeout(ms));
        controller.abort();
      }, ms);
      p.then(
        (channel) => {
          if (done) channel.close();
          else {
            done = true;
            clearTimeout(timer);
            resolve(channel);
          }
        },
        (e: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private async consumeCommand(frame: Uint8Array, gen: number): Promise<void> {
    const envelope = decodeEnvelope(frame);
    if (envelope.kind !== 'system') return;
    const payload = envelope.payload;
    if (this.state === 'registering' && startsWith(payload, '3:')) {
      const reply = parseRegistrationReply(payload);
      this.registration = reply;
      this.diag.registrationAccepted = true;
      this.diag.assignedID = reply.assignedIDText;
      this.state = 'lookup';
      this.status(`Đăng ký OK: ID được cấp ${reply.assignedIDText}`);
      const o = this.options!;
      const lookup = lookupBytes({
        ...LOOKUP_DEFAULTS,
        targetID: o.partnerID,
        credential: { kind: 'password', value: this.password },
        clientVersion: CLIENT_VERSION,
        localID: reply.assignedIDText,
        localPassword: o.identity.password,
        correlationNumber: this.correlation,
        dateTimeOffsetMinutes: -new Date().getTimezoneOffset(),
      });
      const encrypted = commandCipher.encrypt(lookup);
      this.armDeadline(gen);
      this.command?.send(encodeSystem(encrypted, false));
      this.status(`Tìm máy đối tác ${o.partnerID} (lệnh 8)…`);
    } else if (this.state === 'lookup' && startsWith(payload, '8:')) {
      const reply = parseLookupReply(payload);
      if (reply.correlationNumber !== this.correlation) {
        this.status('Bỏ qua lookup reply có correlation lạ');
        return;
      }
      this.diag.lookupStatus = reply.status;
      if (reply.status === 2) throw new Failure('wrongPassword', 'lookup status 2: sai mật khẩu đối tác');
      const info = reply.peerInfo();
      if (info === null) throw new Failure('lookupRejected', `lookup status ${reply.status}: UltraViewer từ chối (ID không tồn tại hoặc đối tác offline?)`);
      let routable = info.targetTCPPort > 0 && info.targetTCPPort <= 0xffff && info.relayIP.length > 0;
      try {
        parseIPv4(info.publicIP);
      } catch {
        routable = false;
      }
      if (!routable) throw new Failure('invalidLookupRoute', 'lookup status 1 nhưng địa chỉ đối tác không đầy đủ');
      this.peerInfo = info;
      this.targetAddress = Array.from(parseIPv4(info.publicIP)).join('.');
      this.targetPort = info.targetTCPPort;
      this.state = 'login';
      this.clearDeadline();
      const name = decodeComputerName(info.computerNameField);
      this.status(`lookup status 1: relay ${info.relayIP}, cert ${info.relayHostname || COMMAND_HOST}${name ? `, máy "${name}"` : ''}`);
      void this.beginPeer(info, gen).catch((e: unknown) => this.fail(e, gen));
    }
  }

  // MARK: - data (peer) connection

  private async beginPeer(info: PeerInfo, gen: number): Promise<void> {
    const hostname = info.relayHostname.length === 0 ? COMMAND_HOST : info.relayHostname;
    const ips = await this.resolveHost(info.relayIP);
    if (!this.live(gen)) return;
    const opened = await this.openFirst(ips, hostname, PEER_CONNECT_MS, gen, 'data');
    if (!opened) return;
    this.peer = opened;
    this.diag.peerTransportOpened = true;
    this.lastInboundAt = this.deps.now();
    opened.channel.onClose((reason) => this.fail(new Failure('transportClosed', `kết nối data đóng: ${reason}`), gen));
    opened.start(
      hostname,
      (frame) => {
        this.peerQueue = this.peerQueue
          .then(() => (this.live(gen) ? this.consumePeer(frame, gen) : undefined))
          .catch((e: unknown) => this.fail(e, gen));
      },
      (e) => this.fail(e, gen),
      () => {
        this.lastInboundAt = this.deps.now();
      },
    );
    this.status('Chờ Windows chấp nhận phiên…');
    if (this.state !== 'active') this.armDeadline(gen);
    this.login(0, false);
  }

  private login(controlMode: number, clearControlMode: boolean): void {
    const o = this.options!;
    const nonce = randomString(8, '0123456789');
    const bytes = loginBytes({ password: this.password, nonce }, {
      ...LOGIN_DEFAULTS,
      screenPixelWidth: o.screenW,
      screenPixelHeight: o.screenH,
      localID: this.registration!.assignedIDText,
      displayName: o.displayName,
      controlMode,
      clearControlMode,
      connectionHashKey: this.connectionHash,
      partnerSecretToken: this.peerInfo!.partnerSecretToken ?? '',
    });
    this.sendToPeer(bytes);
    this.diag.loginSent = true;
    this.status(`Đã gửi login (controlMode ${clearControlMode ? 0 : controlMode})`);
  }

  private sendToPeer(payload: Uint8Array, formatFlag = false): void {
    this.peer?.send(encodeEnvelope({ kind: 'forward', address: this.targetAddress, port: this.targetPort, formatFlag, payload }));
  }

  private async consumePeer(frame: Uint8Array, gen: number): Promise<void> {
    const envelope = decodeEnvelope(frame);
    if (envelope.kind === 'system') {
      if (equalsAscii(envelope.payload, 'pong')) {
        this.diag.relayPongs++;
        this.relayAnswersPings = true;
        if (this.relayPingStarted !== null) {
          this.diag.relayRttMs = this.deps.now() - this.relayPingStarted;
          this.relayPingStarted = null;
        }
      }
      return;
    }
    const knownSource = envelope.address === this.targetAddress && envelope.port === this.targetPort;
    if (!knownSource) {
      // Swift also admits command 26 with the connection hash from another source (relay
      // switch); out of scope for phase 0. Logged so a frozen screen is not silent (pongs
      // keep the watchdog quiet).
      this.diag.ignoredSources++;
      const source = `${envelope.address}:${envelope.port}`;
      if (!this.foreignSources.has(source) && this.foreignSources.size < MAX_LOGGED_FOREIGN_SOURCES) {
        this.foreignSources.add(source);
        this.status(`nguồn lạ ${source}`);
      }
      return;
    }
    const parts = decodeMultipart(envelope.payload);
    const command = parts[0]?.[0];
    if (command === undefined) throw new Failure('protocol', 'tin nhắn đối tác rỗng (malformedInitialization)');
    switch (command) {
      case 0:
        await this.initialize(parts, gen);
        return;
      case 1:
        await this.drawFrame(parts, envelope.payload.length, gen);
        return;
      case 20:
        this.relayAnswersPings = true;
        if (this.peerPingStarted !== null) {
          this.diag.peerRttMs = this.deps.now() - this.peerPingStarted;
          this.peerPingStarted = null;
        }
        return;
      case 27:
      case 41:
      case 54:
        throw new Failure('partnerEnded', `Windows đã kết thúc phiên (lệnh ${command})`);
      case 39:
        throw new Failure('partnerBlocked', 'Windows đã chặn kết nối này (lệnh 39)');
      case 3:
      case 4:
      case 28:
        await this.consumeCursor(parts, gen);
        return;
      case 23:
        // Swift 828-832: the host asks for a new Login; the screen stays (no clear).
        if (this.state !== 'active') return;
        this.state = 'login';
        this.status('Windows yêu cầu đăng nhập lại (lệnh 23)…');
        this.armDeadline(gen);
        this.login(-1, false);
        return;
      case 49: {
        const viewOnly = viewOnlyFlag(parts);
        if (viewOnly === null) throw new Failure('protocol', 'lệnh 49 thiếu cờ quyền điều khiển (malformedInitialization)');
        this.remoteViewOnly = viewOnly;
        if (this.state === 'active') this.on({ type: 'inputPermission', allowed: !viewOnly });
        return;
      }
      case 48:
        if (this.state === 'active' && this.renderer !== null) {
          this.renderer.setTileSize(parts);
          this.status(`tile size → ${this.renderer.tileSize}`);
        }
        return;
      default:
        this.diag.ignoredMessages++;
        if (!this.ignoredIDs.has(command)) {
          this.ignoredIDs.add(command);
          this.status(`ignored ${command}`);
        }
    }
  }

  /** consumeApplication case 0. */
  private async initialize(parts: Uint8Array[], gen: number): Promise<void> {
    if (this.state !== 'login' && this.state !== 'active') return;
    const init = decodeInitialization(parts);
    const previous = this.renderer;
    const geometryChanged = previous === null || previous.width !== init.width || previous.height !== init.height;
    if (geometryChanged && parts.length > 13 && parts[13]!.length === 0) {
      throw new Failure('protocol', 'khởi tạo màn hình thiếu dữ liệu (malformedInitialization)');
    }
    const version = init.targetVersionBytes ? new TextDecoder().decode(init.targetVersionBytes) : '';
    if (!versionAtLeast(version, [6, 0, 0])) {
      throw new Failure('unsupportedVersion', `UltraViewer Windows ${version || '(không rõ)'} chưa được hỗ trợ (cần ≥ 6.0.0)`);
    }
    if (geometryChanged) {
      this.dictionary ??= (this.deps.loadDictionary ?? loadScreenDictionary)();
      const dictionary = await this.dictionary;
      const fresh = await ModernScreenRenderer.create({
        width: init.width,
        height: init.height,
        tileSize: init.tileSize,
        displayColors: 2,
        lastFrameNumber: previous?.lastFrameNumber ?? ModernScreenRenderer.resetFrameNumber,
        dictionary,
        decodeJpeg: this.deps.decodeJpeg,
      });
      if (!this.live(gen)) {
        fresh.dispose();
        return;
      }
      previous?.dispose();
      this.renderer = fresh;
    } else {
      previous.setTileSize([Uint8Array.of(48), Uint8Array.of(init.tileSize)]);
    }
    this.state = 'active';
    this.clearDeadline();
    const previouslyAccepted = this.diag.peerAccepted;
    this.diag.peerAccepted = true;
    this.startHeartbeat(gen);
    const { monitors, error: monitorError } = initMonitors(init);
    if (monitorError !== null && !this.monitorErrorLogged) {
      this.monitorErrorLogged = true;
      this.status(`monitor: bỏ qua thông tin màn hình lỗi (${monitorError})`);
    }
    const peer: Peer = {
      displayName: this.peerInfo ? decodeComputerName(this.peerInfo.computerNameField) : null,
      version,
      width: init.width,
      height: init.height,
      virtualLeft: init.virtualLeft ?? 0,
      virtualTop: init.virtualTop ?? 0,
      supportsBinaryKeyboard: versionAtLeast(version, BINARY_KEYBOARD_VERSION),
      allowsRemoteInput: !this.remoteViewOnly,
      monitors,
    };
    this.status(`init ${init.width}×${init.height}, Windows UltraViewer ${version}, tile ${init.tileSize}`);
    this.on({ type: 'accepted', peer });
    if (previouslyAccepted) this.status('Đã làm mới màn hình Windows');
    if (!this.live(gen) || this.state !== 'active') return;
    // TCP ConnectionType1: the viewer sends ASCII 17 after initialization.
    this.sendToPeer(ASCII.encode('17'));
    // MacViewer ConnectionModel sends cursorPositions(enabled:) once, on the first accept.
    if (!previouslyAccepted) this.sendToPeer(ASCII.encode('28|||1'));
  }

  /** consumeApplication cases 3, 4, 28 (active only; malformed or ignored-hash messages dropped). */
  private async consumeCursor(parts: Uint8Array[], gen: number): Promise<void> {
    if (this.state !== 'active') return;
    const event = await decodeCursor(parts, () => this.loadCursorZstd());
    if (event === null || !this.live(gen) || this.state !== 'active') return;
    this.on({ type: 'cursor', event });
  }

  private loadCursorZstd(): Promise<CursorZstd> {
    if (this.cursorZstd === null) {
      const p = (this.deps.makeCursorZstd ?? makeCursorZstd)();
      this.cursorZstd = p;
      p.catch((e: unknown) => {
        if (this.state !== 'closed') this.status(`Không tải được zstd cho con trỏ: ${describe(e)}`);
      });
    }
    return this.cursorZstd;
  }

  /** consumeApplication case 1. */
  private async drawFrame(parts: Uint8Array[], payloadBytes: number, gen: number): Promise<void> {
    const renderer = this.renderer;
    if (this.state !== 'active' || renderer === null) return;
    this.diag.screenPayloadBytes += payloadBytes;
    const started = this.deps.now();
    try {
      const bitmap = await renderer.apply(decodeFrameMessage(parts));
      // A refresh (manual or automatic) while this frame was decoding replaced the renderer and
      // restarted the login: the frame belongs to a dead screen, and "18" would be sent mid-login.
      if (!this.live(gen) || this.renderer !== renderer || this.state !== 'active') return;
      const elapsed = this.deps.now() - started;
      this.diag.decodeMsTotal += elapsed;
      this.diag.decodeMsMax = Math.max(this.diag.decodeMsMax, elapsed);
      this.diag.decodedFrames++;
      if (this.diag.decodedFrames === 1) {
        this.status(`frame đầu tiên: ${bitmap.width}×${bitmap.height}, giải mã ${elapsed.toFixed(1)} ms, ${payloadBytes} byte`);
      }
      this.decodeErrorRefreshes = 0;
      this.on({ type: 'frame', bitmap });
      // Backpressure follows successful decoding, so a slow client cannot acknowledge a
      // growing queue of stale screen updates.
      this.sendToPeer(ASCII.encode('18'));
    } catch (e) {
      if (this.live(gen) && (this.renderer !== renderer || this.state !== 'active')) return; // stale decode, see above
      if (!(e instanceof ModernScreenMessageError) || !this.live(gen)) throw e;
      this.diag.lastScreenFailure = e.message;
      this.status(`Frame lỗi: ${e.message}`);
      this.sendToPeer(ASCII.encode('18'));
      // Never continue a damaged tile cache: a full initialization resets decoder and cache.
      // Only decode-error refreshes count (manual "Làm mới" does not); a refresh that recovers
      // (init + one good frame) resets the budget, a refresh loop of bad frames still ends the session.
      if (this.decodeErrorRefreshes >= 2) throw new Failure('protocol', `màn hình lỗi lặp lại: ${e.message}`);
      this.decodeErrorRefreshes++;
      this.renegotiateScreen(gen);
    }
  }

  /** Swift refreshScreen: clear-mode Login renegotiates a complete screen. */
  private renegotiateScreen(gen: number): void {
    if (this.state !== 'active') return;
    this.diag.screenRefreshes++;
    this.renderer?.dispose();
    this.renderer = null;
    this.state = 'login';
    this.on({ type: 'inputPermission', allowed: false });
    if (!this.live(gen) || this.state !== 'login') return;
    this.status('Đang làm mới màn hình Windows…');
    this.armDeadline(gen);
    this.login(-1, true);
  }

  // MARK: - timers

  private armDeadline(gen: number): void {
    this.clearDeadline();
    this.deadline = setTimeout(() => {
      if (!this.live(gen) || this.state === 'active') return;
      this.fail(new Failure('deadline', `quá ${PHASE_DEADLINE_MS / 1000} s không có phản hồi (pha ${this.state})`), gen);
    }, PHASE_DEADLINE_MS);
  }

  private clearDeadline(): void {
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private startHeartbeat(gen: number): void {
    if (this.heartbeat !== null) return;
    this.heartbeat = setInterval(() => this.sendHeartbeat(gen), HEARTBEAT_MS);
    this.lastInboundAt = this.deps.now();
    this.lastWatchdogTickAt = this.deps.now();
    this.probeSentAt = null;
    this.watchdog = setInterval(() => this.watchdogTick(gen), WATCHDOG_TICK_MS);
  }

  /**
   * Judges only an unanswered ping, never wall-clock silence: under timer throttling (hidden
   * tab, locked phone) ticks arrive late, so a late tick sends a fresh ping and restarts the
   * window. A dead connection is reported <= PROBE_TIMEOUT_MS + 1 tick after a punctual ping,
   * i.e. <= 19 s after the last byte at the normal 10 s cadence, ~9 s after the tab wakes up.
   */
  private watchdogTick(gen: number): void {
    if (!this.live(gen) || this.state !== 'active') return;
    const now = this.deps.now();
    const late = now - this.lastWatchdogTickAt > LATE_TICK_MS;
    this.lastWatchdogTickAt = now;
    if (late) {
      this.sendPing();
      this.probeSentAt = now;
      return;
    }
    if (this.probeSentAt === null) return;
    if (this.lastInboundAt >= this.probeSentAt) {
      this.probeSentAt = null;
      return;
    }
    const waited = now - this.probeSentAt;
    if (this.relayAnswersPings && waited >= PROBE_TIMEOUT_MS) {
      this.fail(new Failure('transportClosed', `mất kết nối: ping không được trả lời sau ${Math.round(waited / 1000)} s`), gen);
    }
  }

  /** Relay `ping` + peer `"20"`; starts a liveness probe unless one is already outstanding. */
  private sendPing(): void {
    const now = this.deps.now();
    this.relayPingStarted = now;
    this.peer?.send(keepaliveRelayEnvelope());
    this.diag.relayKeepalivesSent++;
    this.peerPingStarted = now;
    this.sendToPeer(ASCII.encode('20'));
    this.probeSentAt ??= now;
  }

  private sendHeartbeat(gen: number): void {
    if (!this.live(gen) || this.state !== 'active') return;
    this.heartbeatTicks++;
    this.sendPing();
    if (this.heartbeatTicks % COMMAND_KEEPALIVE_EVERY === 0) {
      // frmMain.tmPingServer: encrypted ASCII 2, sixty-second interval.
      this.command?.send(keepaliveCommandEnvelope());
      this.diag.commandKeepalivesSent++;
    }
  }

  // MARK: - teardown

  private fail(e: unknown, gen: number): void {
    if (!this.live(gen)) return;
    const failure = classify(e);
    this.status(`Đóng: ${failure.detail}`);
    this.finish(failure.reason);
  }

  private finish(reason: SessionFailure | null): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.generation++;
    this.clearDeadline();
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.heartbeat = null;
    this.watchdog = null;
    const command = this.command;
    const peer = this.peer;
    this.command = null;
    this.peer = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.password = '';
    this.connectionHash = '';
    this.options = null;
    this.registration = null;
    this.peerInfo = null;
    this.targetAddress = '';
    this.targetPort = 0;
    this.relayPingStarted = null;
    this.peerPingStarted = null;
    this.probeSentAt = null;
    command?.channel.close();
    peer?.channel.close();
    this.on({ type: 'closed', reason });
  }
}
