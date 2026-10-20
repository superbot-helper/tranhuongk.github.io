// Manual smoke test against `npx wrangler dev` (local, no login). Usage:
//   npx wrangler dev &   then   node scripts/smoke.mjs
// Reads TOKEN_A from .dev.vars (git-ignored); never prints it. Override base with WORKER=ws://host:port.
import { readFileSync } from 'node:fs';

const BASE = process.env.WORKER ?? 'ws://127.0.0.1:8787';
const RELAY = '146.59.55.107';
const token = /^TOKEN_A=(.+)$/m.exec(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8'))?.[1]?.trim();
if (!token) throw new Error('TOKEN_A missing in .dev.vars');

/** Opens a socket; resolves with {opened, protocol, closeCode, bytes} once it closes (or after `ms`). */
function run(query, protocols, { send, ms = 8000, keepOpen = false } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE}/tcp?${query}`, protocols);
    ws.binaryType = 'arraybuffer';
    const r = { opened: false, protocol: '', closeCode: null, bytes: 0 };
    const finish = () => resolve({ ...r, ws });
    const timer = setTimeout(() => { if (!keepOpen) ws.close(); finish(); }, ms);
    ws.onopen = () => {
      r.opened = true;
      r.protocol = ws.protocol;
      if (send) ws.send(send);
      if (keepOpen) { clearTimeout(timer); finish(); }
    };
    ws.onmessage = (e) => { r.bytes += e.data.byteLength ?? 0; };
    ws.onclose = (e) => { r.closeCode = e.code; clearTimeout(timer); if (!keepOpen) finish(); };
    ws.onerror = () => {};
  });
}
const show = (name, { ws, ...r }) => console.log(name.padEnd(44), JSON.stringify(r));

const good = `ip=${RELAY}&port=443`;
show('a) wrong token (expect 4401)', await run(good, ['uvpipe', 'x'.repeat(40)]));
show('a2) no token (expect 4401)', await run(good, ['uvpipe']));
show('b) ip=192.168.1.1 (expect 4403)', await run('ip=192.168.1.1&port=443', ['uvpipe', token]));
show('b2) port=80 (expect 4403)', await run(`ip=${RELAY}&port=80`, ['uvpipe', token]));
show('b3) hostname (expect 4403)', await run('ip=functions3.ultraviewer.net&port=443', ['uvpipe', token]));
const garbage = await run(good, ['uvpipe', token], { send: new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x05, 0x41, 0x41, 0x41, 0x41, 0x41]) });
show('c) bogus TLS record (expect open, server close)', garbage);

// Concurrency: 4 held open, 5th must get 4429, then freeing one allows a new one.
const held = [];
for (let i = 0; i < 4; i++) held.push(await run(good, ['uvpipe', token], { keepOpen: true }));
show('d) 4 held open (expect opened x4)', { opened: held.every((h) => h.opened), closeCode: held.map((h) => h.closeCode) });
show('d) 5th (expect 4429)', await run(good, ['uvpipe', token]));
held[0].ws.close();
await new Promise((r) => setTimeout(r, 500));
const again = await run(good, ['uvpipe', token], { keepOpen: true });
show('d) after releasing one (expect open)', again);
for (const h of [...held.slice(1), again]) h.ws.close();
await new Promise((r) => setTimeout(r, 500));
process.exit(0);
