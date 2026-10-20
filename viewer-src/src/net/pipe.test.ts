import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { isValidToken, openPipe, PipeError } from './pipe';

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

const TOKEN = 'ab12cd34ef56ab78cd90ef12ab34cd56';
const opts = { workerUrl: 'ws://127.0.0.1:8787', token: TOKEN, ip: '146.59.55.107', port: 443 as const };
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
  expect(ws.url).not.toContain(TOKEN);
  expect(ws.protocols).toEqual(['uvpipe', TOKEN]);
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

test('token format: >= 16 chars of [A-Za-z0-9_-] (openssl rand -hex 32 qualifies)', () => {
  expect(isValidToken(TOKEN)).toBe(true);
  expect(isValidToken('0123456789abcdef')).toBe(true);
  expect(isValidToken('A-b_C'.repeat(4))).toBe(true);
  for (const bad of ['', 'short', '0123456789abcde', 'a b'.repeat(8), 'abc/def+ghi=jklmnop', 'abcdefghijklmnop,', 'đđđđđđđđđđđđđđđđ']) {
    expect(isValidToken(bad)).toBe(false);
  }
});

test('an invalid token rejects (never throws) before any WebSocket, and the error never contains it', async () => {
  const malformed = `MARKER${TOKEN.slice(0, 10)} /=+`; // spaces, '/', '=', '+' are not token chars
  let result: Promise<unknown> | null = null;
  expect(() => {
    result = openPipe({ ...opts, token: malformed });
  }).not.toThrow();
  const err = await result!.catch((e: unknown) => e);
  expect(FakeWebSocket.instances).toHaveLength(0);
  expect(err).toBeInstanceOf(PipeError);
  expect(err).toMatchObject({ code: 'invalidToken' });
  expect(JSON.stringify(err) + String(err) + (err as Error).message).not.toContain('MARKER');
});

test('a WebSocket constructor that throws becomes a rejection with a fixed, secret-free message', async () => {
  class ThrowingWebSocket {
    constructor(_url: string, protocols: string[]) {
      throw new SyntaxError(`The subprotocol '${protocols[1]}' is invalid.`);
    }
  }
  vi.stubGlobal('WebSocket', ThrowingWebSocket);
  let result: Promise<unknown> | null = null;
  expect(() => {
    result = openPipe(opts);
  }).not.toThrow();
  const err = await result!.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PipeError);
  expect(err).toMatchObject({ code: 'cannotOpen' });
  expect((err as Error).message).not.toContain(TOKEN);
});

test('an abort before open closes the socket and rejects with code aborted', async () => {
  const controller = new AbortController();
  const p = openPipe({ ...opts, signal: controller.signal });
  const ws = last();
  controller.abort();
  const err = await p.catch((e: unknown) => e);
  expect(err).toMatchObject({ code: 'aborted' });
  expect(ws.closedWith).toBe(1000);
  ws.open(); // a late open must not resurrect it
  ws.remoteClose(1000);
});

test('an already-aborted signal never creates a socket', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(openPipe({ ...opts, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
  expect(FakeWebSocket.instances).toHaveLength(0);
});

test('an abort after open closes the pipe (the Worker lease is released)', async () => {
  const controller = new AbortController();
  const p = openPipe({ ...opts, signal: controller.signal });
  const ws = last();
  ws.open();
  const pipe = await p;
  const reasons: string[] = [];
  pipe.onClose((r) => reasons.push(r));
  controller.abort();
  expect(ws.closedWith).toBe(1000);
  expect(reasons).toEqual(['closed locally']);
});
