import { describe, expect, test } from 'vitest';
import { PipeError, type BytePipe } from '../net/pipe';
import { TlsError, type TlsChannel, type TlsOptions } from '../net/tls';
import { workerChannelOpener } from './worker-channel';

function fakePipe(): BytePipe & { closed: boolean } {
  return { closed: false, send() {}, onData() {}, onClose() {}, close() { this.closed = true; } };
}

describe('workerChannelOpener', () => {
  test('pipe to ip:443 (no token), then TLS with SNI "ultraviewer" and the given cert name', async () => {
    const calls: unknown[] = [];
    const pipe = fakePipe();
    const channel = { expired: true } as unknown as TlsChannel;
    const open = workerChannelOpener({
      workerUrl: 'ws://127.0.0.1:8787',
      openPipe: async (o) => {
        calls.push(o);
        return pipe;
      },
      openTls: async (p: BytePipe, o: TlsOptions) => {
        calls.push([p === pipe, o]);
        return channel;
      },
    });
    expect(await open('192.0.2.9', 'relay.example')).toBe(channel);
    expect(calls).toEqual([
      { workerUrl: 'ws://127.0.0.1:8787', ip: '192.0.2.9', port: 443, signal: undefined },
      [true, { sni: 'ultraviewer', certName: 'relay.example' }],
    ]);
  });

  test('a failed TLS handshake closes the pipe and rethrows', async () => {
    const pipe = fakePipe();
    const open = workerChannelOpener({
      workerUrl: 'ws://x',
      openPipe: async () => pipe,
      openTls: async () => {
        throw new TlsError('name', 'certificate rejected: name');
      },
    });
    await expect(open('192.0.2.9', 'functions3.ultraviewer.net')).rejects.toMatchObject({ code: 'name' });
    expect(pipe.closed).toBe(true);
  });

  test('an abandoned attempt (signal aborted during TLS) closes its pipe so the Worker lease is freed', async () => {
    const pipe = fakePipe();
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const open = workerChannelOpener({
      workerUrl: 'ws://x',
      openPipe: async (o) => {
        seenSignal = o.signal;
        return pipe;
      },
      openTls: () => new Promise<TlsChannel>(() => {}), // handshake never finishes
    });
    const result = open('192.0.2.9', 'functions3.ultraviewer.net', controller.signal).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    expect(seenSignal).toBe(controller.signal);
    expect(pipe.closed).toBe(false);
    controller.abort();
    expect(pipe.closed).toBe(true);
    expect(await result).toMatchObject({ code: 'aborted' });
  });

  test('a pipe that opens after the abort is closed at once', async () => {
    const pipe = fakePipe();
    const controller = new AbortController();
    let release: (p: BytePipe) => void = () => {};
    const open = workerChannelOpener({
      workerUrl: 'ws://x',
      openPipe: () => new Promise((resolve) => (release = resolve)), // ignores the signal
      openTls: async () => ({}) as TlsChannel,
    });
    const result = open('192.0.2.9', 'functions3.ultraviewer.net', controller.signal).catch((e: unknown) => e);
    controller.abort();
    release(pipe);
    expect(await result).toBeInstanceOf(PipeError);
    expect(pipe.closed).toBe(true);
  });
});
