// Temporary spike page (Task 7 replaces it). The token is kept in memory only.
import { WORKER_URL } from '../config';
import { probeCommandTls } from './probe';

const app = document.getElementById('app');
if (app) {
  app.innerHTML = `
    <h1>UV Web Viewer spike</h1>
    <label>Worker token <input id="token" type="password" autocomplete="off" spellcheck="false"></label>
    <button id="tls-probe" type="button">Thử TLS command</button>
    <button id="screen-selftest" type="button">Thử giải mã màn hình</button>
    <pre id="log"></pre>`;
  const token = app.querySelector<HTMLInputElement>('#token')!;
  const button = app.querySelector<HTMLButtonElement>('#tls-probe')!;
  const logEl = app.querySelector<HTMLPreElement>('#log')!;
  const log = (line: string) => {
    logEl.textContent += `${new Date().toISOString().slice(11, 23)} ${line}\n`;
  };

  button.addEventListener('click', () => {
    if (!WORKER_URL) return log('WORKER_URL is not configured');
    if (!token.value) return log('enter the Worker token first');
    button.disabled = true;
    probeCommandTls({ workerUrl: WORKER_URL, token: token.value.trim(), log })
      .then((r) => log(`TLS OK (cert expired: ${r.expired}), HTTP header received`))
      .catch((e: unknown) => {
        const err = e as { name?: string; code?: string; message?: string };
        log(`FAILED ${err.name ?? 'Error'}${err.code ? `(${err.code})` : ''}: ${err.message ?? String(e)}`);
      })
      .finally(() => (button.disabled = false));
  });

  const screenButton = app.querySelector<HTMLButtonElement>('#screen-selftest')!;
  screenButton.addEventListener('click', () => {
    screenButton.disabled = true;
    import('./screen-selftest')
      .then(({ runScreenSelfTest }) => runScreenSelfTest(log))
      .then((ok) => log(ok ? 'screen self-test PASSED' : 'screen self-test FAILED'))
      .catch((e: unknown) => {
        const err = e as { name?: string; code?: string; message?: string };
        log(`FAILED ${err.name ?? 'Error'}${err.code ? `(${err.code})` : ''}: ${err.message ?? String(e)}`);
      })
      .finally(() => (screenButton.disabled = false));
  });
}
