import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openPipe, PipeError } from './pipe';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  sent: Uint8Array[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
  send(b: Uint8Array) {
    this.sent.push(b.slice());
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // test drivers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  remoteClose(code: number, reason = '') {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.({ code, reason });
  }
}

const opts = { workerUrl: 'ws://127.0.0.1:8787', token: 'ab12', ip: '146.59.55.107', port: 443 as const };
const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('connects to /tcp with the target in the query and the token only as a subprotocol', async () => {
  const p = openPipe(opts);
  const ws = last();
  expect(ws.url).toBe('ws://127.0.0.1:8787/tcp?ip=146.59.55.107&port=443');
  expect(ws.url).not.toContain('ab12');
  expect(ws.protocols).toEqual(['uvpipe', 'ab12']);
  expect(ws.binaryType).toBe('arraybuffer');
  ws.open();
  await p;
});

test('tolerates a trailing slash on the worker URL', async () => {
  const p = openPipe({ ...opts, workerUrl: 'wss://w.example.workers.dev/' });
  expect(last().url).toBe('wss://w.example.workers.dev/tcp?ip=146.59.55.107&port=443');
  last().open();
  await p;
});

test('moves bytes both ways and buffers data that arrives before onData', async () => {
  const p = openPipe(opts);
  const ws = last();
  ws.open();
  const pipe = await p;
  ws.message(new Uint8Array([1, 2]).buffer);
  const got: number[][] = [];
  pipe.onData((b) => got.push([...b]));
  ws.message(new Uint8Array([3]).buffer);
  pipe.send(new Uint8Array([9, 8]));
  expect(got).toEqual([[1, 2], [3]]);
  expect(ws.sent.map((b) => [...b])).toEqual([[9, 8]]);
});

test('a close after open is reported once with code and reason, even to late listeners', async () => {
  const p = openPipe(opts);
  const ws = last();
  ws.open();
  const pipe = await p;
  const reasons: string[] = [];
  pipe.onClose((r) => reasons.push(r));
  ws.remoteClose(4401, 'bad token');
  ws.remoteClose(4401, 'bad token');
  pipe.onClose((r) => reasons.push(`late:${r}`));
  expect(reasons).toEqual(['4401 bad token', 'late:4401 bad token']);
  pipe.send(new Uint8Array([1])); // ignored after close
  expect(ws.sent).toHaveLength(0);
});

test('close before open rejects with the close code', async () => {
  const p = openPipe(opts);
  last().remoteClose(4403, 'forbidden target');
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PipeError);
  expect(err).toMatchObject({ code: 'closedBeforeOpen', closeCode: 4403 });
  expect((err as Error).message).toContain('4403');
});

test('local close() closes the socket and notifies listeners', async () => {
  const p = openPipe(opts);
  const ws = last();
  ws.open();
  const pipe = await p;
  const reasons: string[] = [];
  pipe.onClose((r) => reasons.push(r));
  pipe.close();
  expect(ws.closedWith).toBe(1000);
  expect(reasons).toEqual(['closed locally']);
});

test('rejects text frames by closing the pipe', async () => {
  const p = openPipe(opts);
  const ws = last();
  ws.open();
  const pipe = await p;
  const reasons: string[] = [];
  pipe.onClose((r) => reasons.push(r));
  ws.message('hello');
  expect(reasons).toEqual(['unexpected text message']);
});
