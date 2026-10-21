import { connect } from 'cloudflare:sockets';
import { parseTarget, SUBPROTOCOL } from './guard';
import { ConnLimiter } from './limiter';

export { ConnLimiter };

interface Env {
  LIMITER: DurableObjectNamespace<ConnLimiter>;
}

const MAX_PER_IP = 4;
const LEASE_RENEW_MS = 5 * 60 * 1000; // must stay well under the limiter's lease TTL

// WebSocket close codes (application range).
const CLOSE_FORBIDDEN_TARGET = 4403;
const CLOSE_TOO_MANY = 4429;
const CLOSE_CONNECT_FAILED = 4502;
const CLOSE_UNSUPPORTED_DATA = 1003;
const CLOSE_NORMAL = 1000;

/** Never log payload bytes or client IPs. Close reasons are fixed strings. */
function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // already closed
  }
}

/** Limiter name: SHA-256 of the client IP, so the raw IP is never stored. */
async function ipKey(ip: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Complete the upgrade, then close at once so a browser can read the close code. */
function rejectAfterUpgrade(request: Request, code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  safeClose(server, code, reason);
  // Echo the subprotocol whenever it was offered: a browser aborts the
  // handshake with 1006 when none is selected, which would hide the close code.
  const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '')
    .split(',')
    .map((p) => p.trim());
  const headers = offered.includes(SUBPROTOCOL) ? { 'Sec-WebSocket-Protocol': SUBPROTOCOL } : undefined;
  return new Response(null, { status: 101, webSocket: client, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/tcp') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const target = parseTarget(url.searchParams.get('ip'), url.searchParams.get('port'));
    if (target === null) return rejectAfterUpgrade(request, CLOSE_FORBIDDEN_TARGET, 'forbidden target');

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const clientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    ctx.waitUntil(pipe(server, target, clientIp, env));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL },
    });
  },
} satisfies ExportedHandler<Env>;

/** Dumb byte pipe: WS binary messages <-> raw TCP bytes. Payload is never inspected. */
async function pipe(
  ws: WebSocket,
  target: { ip: string; port: number },
  clientIp: string,
  env: Env,
): Promise<void> {
  let wsClosed = false;
  let closeSocket: () => void = () => {};
  let release: () => Promise<void> = async () => {};
  let renewTimer: ReturnType<typeof setInterval> | undefined;

  ws.binaryType = 'arraybuffer';
  ws.addEventListener('close', () => {
    wsClosed = true;
    closeSocket();
  });
  ws.addEventListener('error', () => {
    wsClosed = true;
    closeSocket();
  });

  // Messages may arrive before TCP is ready; queue writes in order behind `ready`.
  let ready: (w: WritableStreamDefaultWriter<Uint8Array> | null) => void = () => {};
  const writerReady = new Promise<WritableStreamDefaultWriter<Uint8Array> | null>((r) => (ready = r));
  let chain: Promise<void> = Promise.resolve();
  ws.addEventListener('message', (event) => {
    const data = event.data;
    if (typeof data === 'string') {
      safeClose(ws, CLOSE_UNSUPPORTED_DATA, 'binary only');
      return;
    }
    chain = chain.then(async () => {
      const writer = await writerReady;
      if (writer === null) return;
      try {
        // With the standard binaryType a message is a Blob; convert inside the chain to keep order.
        const bytes =
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(await (data as Blob).arrayBuffer());
        await writer.write(bytes);
      } catch {
        safeClose(ws, CLOSE_CONNECT_FAILED, 'tcp write failed');
      }
    });
  });

  try {
    // Concurrency limit: one Durable Object per client IP, max 4 live pipes.
    const limiter = env.LIMITER.get(env.LIMITER.idFromName(await ipKey(clientIp)));
    const connId = crypto.randomUUID();
    if (!(await limiter.acquire(connId, MAX_PER_IP))) {
      ready(null);
      safeClose(ws, CLOSE_TOO_MANY, 'too many connections');
      return;
    }
    release = () => limiter.release(connId).catch(() => {});
    renewTimer = setInterval(() => void limiter.renew(connId).catch(() => {}), LEASE_RENEW_MS);

    if (wsClosed) {
      ready(null);
      return;
    }

    const socket = connect({ hostname: target.ip, port: target.port });
    socket.closed.catch(() => {}); // a peer reset rejects this; handled via the read loop
    closeSocket = () => {
      socket.close().catch(() => {});
    };
    try {
      await socket.opened;
    } catch {
      ready(null);
      safeClose(ws, CLOSE_CONNECT_FAILED, 'tcp connect failed');
      return;
    }
    if (wsClosed) {
      ready(null);
      closeSocket();
      return;
    }
    const writer = socket.writable.getWriter();
    writer.closed.catch(() => {});
    ready(writer);

    // TCP -> WS
    const reader = socket.readable.getReader();
    reader.closed.catch(() => {});
    try {
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        if (wsClosed) break;
        ws.send(value);
      }
    } catch {
      // read error: fall through to close
    }
    safeClose(ws, CLOSE_NORMAL, 'tcp closed');
  } catch {
    safeClose(ws, CLOSE_CONNECT_FAILED, 'internal error');
  } finally {
    ready(null);
    clearInterval(renewTimer);
    closeSocket();
    await release();
  }
}
