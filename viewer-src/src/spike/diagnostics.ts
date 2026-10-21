// Phase-0 spike page turned into the viewer's "Diagnostics" module: connect-form checks,
// failure texts, the stats line and the collapsible diagnostics section
// (Worker URL, TLS probe, log). Never logs or stores the partner password. The Worker
// has no token (owner decision 2026-10-21).
import type { SessionDiagnostics, SessionFailure, SessionPhase } from '../session/relay-session';
import { probeCommandTls } from './probe';

/** Key of the Worker token that older versions stored; removed on load. */
const LEGACY_TOKEN_KEY = 'uvweb.token';
const MAX_LOG_LINES = 400;

export const REASONS: Record<SessionFailure, string> = {
  wrongPassword: 'Sai mật khẩu đối tác.',
  lookupRejected: 'UltraViewer từ chối tìm đối tác (ID sai hoặc máy đang offline?).',
  invalidLookupRoute: 'UltraViewer trả về địa chỉ đối tác không đầy đủ.',
  unsupportedVersion: 'Phiên bản UltraViewer trên Windows chưa được hỗ trợ.',
  deadline: 'Hết thời gian chờ (20 s).',
  transportClosed: 'Mất kết nối.',
  tls: 'Lỗi TLS / chứng chỉ relay.',
  workerRefused: 'Worker từ chối kết nối (mã trong log: 4403 = đích bị cấm, 4429 = quá nhiều kết nối, 4502 = Worker không mở được TCP).',
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

/** Deletes a Worker token left in either storage by an older version (the Worker has no token now). */
export function purgeLegacyToken(): void {
  for (const get of [() => localStorage, () => sessionStorage]) {
    try {
      get().removeItem(LEGACY_TOKEN_KEY);
    } catch {
      // storage blocked: nothing was stored here either
    }
  }
}

export interface ConnectFields {
  workerUrl: string;
  partnerID: string;
  password: string;
}

/** The first problem with the connect form, as a log line; null when it can be submitted. */
export function connectFormError(f: ConnectFields): string | null {
  if (!f.workerUrl) return 'Chưa có Worker URL (mở Diagnostics để nhập).';
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
export function mountDiagnostics(details: HTMLDetailsElement, o: { workerUrl: string }): Diagnostics {
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
    if (!url) return log('Chưa có Worker URL.');
    probeButton.disabled = true;
    probeCommandTls({ workerUrl: url, log })
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
