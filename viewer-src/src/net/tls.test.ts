import { describe, expect, test } from 'vitest';
import forge from 'node-forge';
import type { BytePipe } from './pipe';
import { openTls, TlsError } from './tls';
import { makeCert } from './test-certs';

/** One end of an in-memory pipe pair; delivery is async like a real socket. */
class TestEnd implements BytePipe {
  closed: string | null = null;
  peer: TestEnd | null = null;
  private readonly data: ((b: Uint8Array) => void)[] = [];
  private readonly closeCbs: ((r: string) => void)[] = [];
  send(b: Uint8Array): void {
    if (this.closed !== null) return;
    const copy = b.slice();
    setTimeout(() => this.peer?.data.forEach((cb) => cb(copy)), 0);
  }
  onData(cb: (b: Uint8Array) => void): void {
    this.data.push(cb);
  }
  onClose(cb: (r: string) => void): void {
    this.closeCbs.push(cb);
  }
  close(): void {
    this.shut('closed locally');
    setTimeout(() => this.peer?.shut('closed by peer'), 0);
  }
  /** Test driver: the remote side (worker) closed the pipe. */
  shut(reason: string): void {
    if (this.closed !== null) return;
    this.closed = reason;
    this.closeCbs.forEach((cb) => cb(reason));
  }
}

function pipePair(): [TestEnd, TestEnd] {
  const a = new TestEnd();
  const b = new TestEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

const root = makeCert({ cn: 'Test Root', ca: true });
const mid = makeCert({ cn: 'Test Mid', ca: true, issuer: root });
const expiredLeaf = makeCert({
  cn: 'relay.test',
  dns: ['relay.test'],
  issuer: mid,
  notBefore: new Date('2025-01-01'),
  notAfter: new Date('2026-05-01'),
});

interface Server {
  sni: string[];
  received: number[];
}

/** forge TLS server on `end`: echoes application data back. */
function startServer(end: BytePipe, leaf = expiredLeaf): Server {
  const s: Server = { sni: [], received: [] };
  const conn = forge.tls.createConnection({
    server: true,
    verifyClient: false,
    connected: () => {},
    getCertificate: (_c, hint) => {
      s.sni.push(...(hint as string[]));
      return [leaf.pem, mid.pem];
    },
    getPrivateKey: () => leaf.keyPem,
    tlsDataReady: (c) => end.send(forge.util.binary.raw.decode(c.tlsData.getBytes())),
    dataReady: (c) => {
      const bytes = c.data.getBytes();
      s.received.push(...forge.util.binary.raw.decode(bytes));
      c.prepare(bytes);
    },
    closed: () => end.close(),
    error: () => {},
  });
  end.onData((b) => conn.process(forge.util.binary.raw.encode(b)));
  return s;
}

const base = { sni: 'ultraviewer' as const, certName: 'relay.test', trustAnchors: [root.der] };

describe('openTls over a BytePipe', () => {
  test('handshakes with SNI "ultraviewer", reports expiry, and moves application bytes both ways', async () => {
    const [client, server] = pipePair();
    const srv = startServer(server);
    const ch = await openTls(client, { ...base, now: () => new Date('2026-10-20') });
    expect(srv.sni).toEqual(['ultraviewer']);
    expect(ch.expired).toBe(true);
    expect(ch.chainCheck).toEqual({ ok: true, expired: true });

    const payload = Uint8Array.from({ length: 256 }, (_, i) => i);
    const echoed: number[] = [];
    const done = new Promise<void>((resolve) =>
      ch.onData((b) => {
        echoed.push(...b);
        if (echoed.length >= payload.length) resolve();
      }),
    );
    ch.send(payload);
    await done;
    expect(echoed).toEqual([...payload]);
    expect(srv.received).toEqual([...payload]);
  });

  test('expired is false when now is inside every validity window', async () => {
    const [client, server] = pipePair();
    startServer(server, makeCert({ cn: 'relay.test', dns: ['relay.test'], issuer: mid }));
    const ch = await openTls(client, base);
    expect(ch.expired).toBe(false);
  });

  test('wrong certificate name => TlsError(name), pipe closed', async () => {
    const [client, server] = pipePair();
    startServer(server);
    const err = await openTls(client, { ...base, certName: 'functions3.ultraviewer.net' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TlsError);
    expect(err).toMatchObject({ code: 'name' });
    expect(client.closed).not.toBeNull();
  });

  test('chain not reaching an anchor => TlsError(untrusted)', async () => {
    const [client, server] = pipePair();
    startServer(server);
    const other = makeCert({ cn: 'Other Root', ca: true });
    await expect(openTls(client, { ...base, trustAnchors: [other.der] })).rejects.toMatchObject({ code: 'untrusted' });
  });

  test('the bundled anchors (default) do not trust a test CA', async () => {
    const [client, server] = pipePair();
    startServer(server);
    await expect(openTls(client, { sni: 'ultraviewer', certName: 'relay.test' })).rejects.toMatchObject({ code: 'untrusted' });
  });

  test('pipe closing during the handshake => TlsError(closed) carrying the pipe reason', async () => {
    const [client] = pipePair(); // nobody answers the ClientHello
    const p = openTls(client, base);
    // Simulate the worker's post-upgrade rejection.
    setTimeout(() => client.shut('4401 bad token'), 5);
    const err = await p.catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'closed' });
    expect((err as Error).message).toContain('4401 bad token');
  });

  test('silent peer => TlsError(handshake) after the timeout', async () => {
    const [client] = pipePair();
    await expect(openTls(client, { ...base, handshakeTimeoutMs: 30 })).rejects.toMatchObject({ code: 'handshake' });
    expect(client.closed).not.toBeNull();
  });

  test('non-TLS garbage from the peer => TlsError(handshake)', async () => {
    const [client, server] = pipePair();
    server.onData(() => server.send(new TextEncoder().encode('HTTP/1.1 400 Bad Request\r\n\r\n')));
    await expect(openTls(client, base)).rejects.toMatchObject({ code: 'handshake' });
  });

  test('after connect, a pipe close reaches channel listeners; close() closes the pipe', async () => {
    const [client, server] = pipePair();
    startServer(server);
    const ch = await openTls(client, base);
    const reasons: string[] = [];
    ch.onClose((r) => reasons.push(r));
    client.shut('1000 tcp closed');
    expect(reasons).toEqual(['1000 tcp closed']);

    const [client2, server2] = pipePair();
    startServer(server2);
    const ch2 = await openTls(client2, base);
    const reasons2: string[] = [];
    ch2.onClose((r) => reasons2.push(r));
    ch2.close();
    expect(client2.closed).not.toBeNull();
    expect(reasons2).toHaveLength(1);
    ch2.send(new Uint8Array([1])); // no throw after close
  });
});
