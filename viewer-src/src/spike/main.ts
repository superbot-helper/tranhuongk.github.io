// Phase-0 spike page: connect form, diagnostics log, canvas with the newest frame.
// Never logs or stores the partner password; the Worker token goes only into
// Sec-WebSocket-Protocol (and, when the owner allows it, into this device's storage).
import { WORKER_URL } from '../config';
import { resolveIPv4 } from '../net/dns';
import { DEFAULT_DISPLAY_NAME } from '../proto/client-defaults';
import type { ScreenBitmap } from '../proto/screen-renderer';
import { createIdentity, forgetDevice, IDENTITY_STORAGE_KEY, loadIdentity, saveIdentity, type ClientIdentity } from '../session/identity';
import { createFrameScheduler } from '../session/latest-frame';
import { RelaySession, RelaySessionError, type SessionFailure } from '../session/relay-session';
import { workerChannelOpener } from '../session/worker-channel';
import { probeCommandTls } from './probe';

const TOKEN_KEY = 'uvweb.token';
const MAX_LOG_LINES = 400;

const REASONS: Record<SessionFailure, string> = {
  wrongPassword: 'Sai mật khẩu đối tác.',
  lookupRejected: 'UltraViewer từ chối tìm đối tác (ID sai hoặc máy đang offline?).',
  invalidLookupRoute: 'UltraViewer trả về địa chỉ đối tác không đầy đủ.',
  unsupportedVersion: 'Phiên bản UltraViewer trên Windows chưa được hỗ trợ.',
  deadline: 'Hết thời gian chờ (20 s).',
  transportClosed: 'Mất kết nối.',
  tls: 'Lỗi TLS / chứng chỉ relay.',
  workerRefused: 'Worker từ chối kết nối (mã trong log; 4401 = token sai).',
  protocol: 'Dữ liệu nhận được không hợp lệ (chi tiết trong log).',
};

function readStorage(get: () => Storage, key: string): string | null {
  try {
    return get().getItem(key);
  } catch {
    return null;
  }
}

function loadToken(): { token: string; remembered: boolean } {
  const session = readStorage(() => sessionStorage, TOKEN_KEY);
  if (session) return { token: session, remembered: false };
  const local = readStorage(() => localStorage, TOKEN_KEY);
  return { token: local ?? '', remembered: local !== null };
}

/** Same placement rule as the identity: unchecked -> sessionStorage, checked -> localStorage. */
function saveToken(token: string, remember: boolean): void {
  const [target, other] = remember ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
  target.setItem(TOKEN_KEY, token);
  other.removeItem(TOKEN_KEY);
}

const app = document.getElementById('app');
if (app) {
  app.innerHTML = `
    <h1>UV Web Viewer <small>(thử nghiệm)</small></h1>
    <form id="connect-form" autocomplete="off">
      <label>Worker token
        <input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <label class="check"><input id="remember" type="checkbox"> Nhớ trên thiết bị này</label>
      <label>ID đối tác
        <input id="partner" inputmode="numeric" autocomplete="off" required></label>
      <label>Mật khẩu đối tác
        <input id="password" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <div class="row">
        <button id="connect" type="submit">Kết nối</button>
        <button id="disconnect" type="button" disabled>Ngắt</button>
      </div>
      <button id="forget" type="button" class="secondary">Quên thiết bị này</button>
    </form>
    <p id="status" role="status">Chưa kết nối</p>
    <p id="stats"></p>
    <canvas id="screen" width="16" height="9"></canvas>
    <details id="diagnostics">
      <summary>Diagnostics</summary>
      <label>Worker URL <input id="worker-url" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <button id="tls-probe" type="button">Thử TLS command</button>
    </details>
    <pre id="log"></pre>`;

  const $ = <T extends HTMLElement>(id: string) => app.querySelector<T>(`#${id}`)!;
  const form = $<HTMLFormElement>('connect-form');
  const tokenInput = $<HTMLInputElement>('token');
  const remember = $<HTMLInputElement>('remember');
  const partner = $<HTMLInputElement>('partner');
  const password = $<HTMLInputElement>('password');
  const connectButton = $<HTMLButtonElement>('connect');
  const disconnectButton = $<HTMLButtonElement>('disconnect');
  const forgetButton = $<HTMLButtonElement>('forget');
  const statusEl = $<HTMLParagraphElement>('status');
  const statsEl = $<HTMLParagraphElement>('stats');
  const canvas = $<HTMLCanvasElement>('screen');
  const workerUrl = $<HTMLInputElement>('worker-url');
  const probeButton = $<HTMLButtonElement>('tls-probe');
  const logEl = $<HTMLPreElement>('log');
  const context = canvas.getContext('2d');

  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    logEl.textContent = lines.join('\n');
  };
  const setStatus = (text: string) => {
    statusEl.textContent = text;
  };

  // Identity: the stored copy, else a new one kept in memory until the first connect.
  let identity: ClientIdentity = loadIdentity() ?? createIdentity();
  const stored = loadToken();
  tokenInput.value = stored.token;
  remember.checked = stored.remembered || readStorage(() => localStorage, IDENTITY_STORAGE_KEY) !== null;
  workerUrl.value = WORKER_URL;
  log(`Trang sẵn sàng. Worker: ${WORKER_URL || '(chưa cấu hình — nhập trong Diagnostics)'}`);

  /** saveIdentity/saveToken throw on blocked storage: keep everything in memory for this tab. */
  const persist = () => {
    try {
      saveIdentity(identity, remember.checked);
      const token = tokenInput.value.trim();
      if (token) saveToken(token, remember.checked);
    } catch (e) {
      log(`Cảnh báo: không lưu được vào storage (${(e as Error).name}); danh tính chỉ giữ trong tab này.`);
    }
  };
  remember.addEventListener('change', persist);

  // Newest-frame-wins: decode -> draw on the next animation frame, stale frames skipped.
  const draw = createFrameScheduler<ScreenBitmap>((bitmap) => {
    if (!context) return;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const pixels = bitmap.rgba as Uint8ClampedArray<ArrayBuffer>;
    context.putImageData(new ImageData(pixels, bitmap.width, bitmap.height), 0, 0);
  });

  let session: RelaySession | null = null;
  let startedAt = 0;
  let clock: ReturnType<typeof setInterval> | null = null;

  const renderStats = () => {
    if (!session) return;
    const d = session.diagnostics;
    const seconds = Math.floor((performance.now() - startedAt) / 1000);
    const elapsed = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    const avg = d.decodedFrames ? (d.decodeMsTotal / d.decodedFrames).toFixed(1) : '–';
    const rtt = d.relayRttMs === null ? '–' : `${Math.round(d.relayRttMs)} ms`;
    statsEl.textContent =
      `⏱ ${elapsed} · pha ${session.phase} · ${d.decodedFrames} frame · giải mã TB ${avg} ms ` +
      `(max ${d.decodeMsMax.toFixed(1)}) · relay RTT ${rtt} · pong ${d.relayPongs}`;
  };

  const setBusy = (busy: boolean) => {
    connectButton.disabled = busy;
    disconnectButton.disabled = !busy;
    forgetButton.disabled = busy;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = workerUrl.value.trim();
    const token = tokenInput.value.trim();
    const partnerID = partner.value.replace(/\s+/g, '');
    if (!url) return log('Chưa có Worker URL (mở Diagnostics để nhập).');
    if (!token) return log('Nhập Worker token trước.');
    if (!/^[0-9]{1,64}$/.test(partnerID)) return log('ID đối tác chỉ gồm chữ số.');
    if (!password.value) return log('Nhập mật khẩu đối tác.');
    persist();

    const current = new RelaySession({
      openChannel: workerChannelOpener({ workerUrl: url, token }),
      resolve: resolveIPv4,
      now: () => performance.now(),
    });
    session = current;
    try {
      current.connect(
        {
          identity,
          partnerID,
          password: password.value,
          screenW: Math.round(screen.width * devicePixelRatio),
          screenH: Math.round(screen.height * devicePixelRatio),
          displayName: DEFAULT_DISPLAY_NAME,
        },
        (e) => {
          if (session !== current) return;
          switch (e.type) {
            case 'status':
              log(e.text);
              break;
            case 'accepted':
              canvas.width = e.peer.width;
              canvas.height = e.peer.height;
              setStatus(`Đã kết nối${e.peer.displayName ? ` tới ${e.peer.displayName}` : ''} (${e.peer.width}×${e.peer.height})`);
              break;
            case 'frame':
              draw.push(e.bitmap);
              break;
            case 'closed':
              draw.clear();
              if (clock !== null) clearInterval(clock);
              clock = null;
              renderStats();
              setStatus(e.reason === null ? 'Đã ngắt.' : REASONS[e.reason]);
              log(`Phiên kết thúc: ${e.reason ?? 'người dùng ngắt'}`);
              setBusy(false);
              break;
          }
        },
      );
    } catch (e) {
      log(`Không bắt đầu được phiên: ${e instanceof RelaySessionError ? e.code : (e as Error).name}`);
      return;
    }
    startedAt = performance.now();
    clock = setInterval(renderStats, 1000);
    setStatus('Đang kết nối…');
    setBusy(true);
  });

  disconnectButton.addEventListener('click', () => session?.close());

  forgetButton.addEventListener('click', () => {
    forgetDevice();
    identity = createIdentity();
    tokenInput.value = '';
    remember.checked = false;
    log('Đã xoá danh tính và token đã lưu trên thiết bị này; lần kết nối sau dùng danh tính mới.');
  });

  document.addEventListener('visibilitychange', () => {
    log(`Tab ${document.visibilityState === 'hidden' ? 'bị ẩn' : 'hiện lại'} (pha ${session?.phase ?? 'closed'})`);
  });
  window.addEventListener('pagehide', (e) => {
    log(`pagehide (persisted: ${e.persisted}, pha ${session?.phase ?? 'closed'})`);
  });

  probeButton.addEventListener('click', () => {
    const url = workerUrl.value.trim();
    const token = tokenInput.value.trim();
    if (!url) return log('Chưa có Worker URL.');
    if (!token) return log('Nhập Worker token trước.');
    probeButton.disabled = true;
    probeCommandTls({ workerUrl: url, token, log })
      .then((r) => log(`TLS OK (cert expired: ${r.expired}), HTTP header received`))
      .catch((e: unknown) => {
        const err = e as { name?: string; code?: string; message?: string };
        log(`FAILED ${err.name ?? 'Error'}${err.code ? `(${err.code})` : ''}: ${err.message ?? String(e)}`);
      })
      .finally(() => (probeButton.disabled = false));
  });
}
