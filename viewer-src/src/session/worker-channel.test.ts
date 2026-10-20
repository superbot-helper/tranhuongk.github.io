import { describe, expect, test } from 'vitest';
import type { BytePipe } from '../net/pipe';
import { TlsError, type TlsChannel, type TlsOptions } from '../net/tls';
import { workerChannelOpener } from './worker-channel';

const SENTINEL_TOKEN = 'sentineltoken' + 'ab'.repeat(8);

function fakePipe(): BytePipe & { closed: boolean } {
  return { closed: false, send() {}, onData() {}, onClose() {}, close() { this.closed = true; } };
}

describe('workerChannelOpener', () => {
  test('pipe to ip:443 with the token, then TLS with SNI "ultraviewer" and the given cert name', async () => {
    const calls: unknown[] = [];
    const pipe = fakePipe();
    const channel = { expired: true } as unknown as TlsChannel;
    const open = workerChannelOpener({
      workerUrl: 'ws://127.0.0.1:8787',
      token: SENTINEL_TOKEN,
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
      { workerUrl: 'ws://127.0.0.1:8787', token: SENTINEL_TOKEN, ip: '192.0.2.9', port: 443 },
      [true, { sni: 'ultraviewer', certName: 'relay.example' }],
    ]);
  });

  test('a failed TLS handshake closes the pipe and rethrows', async () => {
    const pipe = fakePipe();
    const open = workerChannelOpener({
      workerUrl: 'ws://x',
      token: SENTINEL_TOKEN,
      openPipe: async () => pipe,
      openTls: async () => {
        throw new TlsError('name', 'certificate rejected: name');
      },
    });
    await expect(open('192.0.2.9', 'functions3.ultraviewer.net')).rejects.toMatchObject({ code: 'name' });
    expect(pipe.closed).toBe(true);
  });
});
