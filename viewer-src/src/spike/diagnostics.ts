// Phase-0 spike page turned into the viewer's "Diagnostics" module: connect-form checks,
// token storage, failure texts, the stats line and the collapsible diagnostics section
// (Worker URL, TLS probe, log). Never logs or stores the partner password; the Worker token
// goes only into Sec-WebSocket-Protocol (and, when the owner allows it, into this device's storage).
import { isValidToken } from '../net/pipe';
import type { SessionDiagnostics, SessionFailure, SessionPhase } from '../session/relay-session';
import { probeCommandTls } from './probe';

const TOKEN_KEY = 'uvweb.token';
/** Fixed text: never echo the token (a browser error for a bad subprotocol quotes it). */
export const BAD_TOKEN_FORMAT = 'Token sai định dạng (cần ≥ 16 ký tự A-Z, a-z, 0-9, _ hoặc -; tạo bằng openssl rand -hex 32).';
const MAX_LOG_LINES = 400;

export const REASONS: Record<SessionFailure, string> = {
  wrongPassword: 'Sai mật khẩu đối tác.',
  lookupRejected: 'UltraViewer từ chối tìm đối tác (ID sai hoặc máy đang offline?).',
  invalidLookupRoute: 'UltraViewer trả về địa chỉ đối tác không đầy đủ.',
  unsupportedVersion: 'Phiên bản UltraViewer trên Windows chưa được hỗ trợ.',
  deadline: 'Hết thời gian chờ (20 s).',
  transportClosed: 'Mất kết nối.',
  tls: 'Lỗi TLS / chứng chỉ relay.',
  workerRefused: 'Worker từ chối kết nối (mã trong log; 4401 = token sai).',
  protocol: 'Dữ liệu nhận được không hợp lệ (chi tiết trong log).',
  partnerEnded: 'Máy Windows đã kết thúc phiên.',
  partnerBlocked: 'Máy Windows đã chặn kết nối này.',
};

export function readStorage(get: () => Storage, key: string): string | null {
  try {
    return get().getItem(key);
  } catch {
    return null;
  }
}

export function loadToken(): { token: string; remembered: boolean } {
  const session = readStorage(() => sessionStorage, TOKEN_KEY);
  if (session) return { token: session, remembered: false };
  const local = readStorage(() => localStorage, TOKEN_KEY);
  return { token: local ?? '', remembered: local !== null };
}

/** Same placement rule as the identity: unchecked -> sessionStorage, checked -> localStorage. Throws on blocked storage. */
export function saveToken(token: string, remember: boolean): void {
  const [target, other] = remember ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
  target.setItem(TOKEN_KEY, token);
  other.removeItem(TOKEN_KEY);
}

export interface ConnectFields {
  workerUrl: string;
  token: string;
  partnerID: string;
  password: string;
}

/** The first problem with the connect form, as a log line; null when it can be submitted. */
export function connectFormError(f: ConnectFields): string | null {
  if (!f.workerUrl) return 'Chưa có Worker URL (mở Diagnostics để nhập).';
  if (!f.token) return 'Nhập Worker token trước.';
  if (!isValidToken(f.token)) return BAD_TOKEN_FORMAT;
  if (!/^[0-9]{1,64}$/.test(f.partnerID)) return 'ID đối tác chỉ gồm chữ số.';
  if (!f.password) return 'Nhập mật khẩu đối tác.';
  return null;
}

export function formatStats(phase: SessionPhase, d: Readonly<SessionDiagnostics>, elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const elapsed = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const avg = d.decodedFrames ? (d.decodeMsTotal / d.decodedFrames).toFixed(1) : '–';
  const rtt = d.relayRttMs === null ? '–' : `${Math.round(d.relayRttMs)} ms`;
  return (
    `⏱ ${elapsed} · pha ${phase} · ${d.decodedFrames} frame · giải mã TB ${avg} ms ` +
    `(max ${d.decodeMsMax.toFixed(1)}) · relay RTT ${rtt} · pong ${d.relayPongs} · ` +
    `bỏ qua ${d.ignoredMessages} tin / ${d.ignoredSources} từ nguồn lạ`
  );
}

export interface Diagnostics {
  log(line: string): void;
  setStats(text: string): void;
  workerUrl(): string;
}

/** Fills `details` with the diagnostics section: stats line, Worker URL, TLS probe and the log. */
export function mountDiagnostics(details: HTMLDetailsElement, o: { workerUrl: string; token: () => string }): Diagnostics {
  details.innerHTML = `
    <summary>Diagnostics</summary>
    <p id="stats"></p>
    <label>Worker URL <input id="worker-url" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <button id="tls-probe" type="button">Thử TLS command</button>
    <pre id="log"></pre>`;
  const statsEl = details.querySelector<HTMLParagraphElement>('#stats')!;
  const workerUrl = details.querySelector<HTMLInputElement>('#worker-url')!;
  const probeButton = details.querySelector<HTMLButtonElement>('#tls-probe')!;
  const logEl = details.querySelector<HTMLPreElement>('#log')!;
  workerUrl.value = o.workerUrl;

  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    logEl.textContent = lines.join('\n');
  };

  probeButton.addEventListener('click', () => {
    const url = workerUrl.value.trim();
    const token = o.token();
    if (!url) return log('Chưa có Worker URL.');
    if (!token) return log('Nhập Worker token trước.');
    if (!isValidToken(token)) return log(BAD_TOKEN_FORMAT);
    probeButton.disabled = true;
    probeCommandTls({ workerUrl: url, token, log })
      .then((r) => log(`TLS OK (cert expired: ${r.expired}), HTTP header received`))
      .catch((e: unknown) => {
        const err = e as { name?: string; code?: string; message?: string };
        log(`FAILED ${err.name ?? 'Error'}${err.code ? `(${err.code})` : ''}: ${err.message ?? String(e)}`);
      })
      .finally(() => (probeButton.disabled = false));
  });

  return {
    log,
    setStats: (text) => {
      statsEl.textContent = text;
    },
    workerUrl: () => workerUrl.value.trim(),
  };
}
