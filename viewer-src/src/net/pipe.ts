// WebSocket to the Cloudflare Worker (`GET /tcp?ip=&port=`) exposed as a raw byte pipe.
// The access token travels only in Sec-WebSocket-Protocol, never in the URL.

export interface BytePipe {
  send(b: Uint8Array): void;
  onData(cb: (b: Uint8Array) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

export type PipeErrorCode =
  /** The socket closed before the upgrade completed (`closeCode` says why). */
  | 'closedBeforeOpen'
  /** The token is not a valid subprotocol token; no socket was created. */
  | 'invalidToken'
  /** The WebSocket constructor threw (bad Worker URL); its message is not kept (it can quote the token). */
  | 'cannotOpen'
  /** The caller's AbortSignal fired before the socket opened. */
  | 'aborted';

const FIXED_MESSAGES: Record<Exclude<PipeErrorCode, 'closedBeforeOpen'>, string> = {
  invalidToken: 'worker token has an invalid format (need >= 16 chars of A-Z a-z 0-9 _ -)',
  cannotOpen: 'worker WebSocket could not be created (check the Worker URL)',
  aborted: 'worker pipe attempt abandoned',
};

export class PipeError extends Error {
  readonly code: PipeErrorCode;
  /** WebSocket close code (4401 bad token, 4403 forbidden target, 4429 too many, 4502 connect failed, 1006 network); 0 when no socket closed. */
  readonly closeCode: number;
  constructor(closeCode: number, reason: string);
  constructor(code: Exclude<PipeErrorCode, 'closedBeforeOpen'>);
  constructor(a: number | Exclude<PipeErrorCode, 'closedBeforeOpen'>, reason = '') {
    // Messages are fixed strings or Worker close reasons: never the token.
    super(typeof a === 'number' ? `worker pipe closed before open: ${describeClose(a, reason)}` : FIXED_MESSAGES[a]);
    this.name = 'PipeError';
    this.code = typeof a === 'number' ? 'closedBeforeOpen' : a;
    this.closeCode = typeof a === 'number' ? a : 0;
  }
}

/** Sec-WebSocket-Protocol token syntax, narrowed: what `openssl rand -hex 32` produces fits. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

export function isValidToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export const PIPE_SUBPROTOCOL = 'uvpipe';

function describeClose(code: number, reason: string): string {
  return reason ? `${code} ${reason}` : String(code);
}

export interface PipeOptions {
  workerUrl: string;
  token: string;
  ip: string;
  port: 443;
  /** Abandons the attempt: closes the socket (before or after open) so the Worker lease is freed. */
  signal?: AbortSignal;
}

/**
 * Note: the Worker completes the upgrade before rejecting (so the close code is readable),
 * so a bad token usually resolves here and then closes with 4401 — watch `onClose`.
 * Never throws synchronously; every failure is a rejected PipeError without the token.
 */
export function openPipe(o: PipeOptions): Promise<BytePipe> {
  if (!isValidToken(o.token)) return Promise.reject(new PipeError('invalidToken'));
  if (o.signal?.aborted) return Promise.reject(new PipeError('aborted'));
  const url = `${o.workerUrl.replace(/\/+$/, '')}/tcp?ip=${encodeURIComponent(o.ip)}&port=${o.port}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, [PIPE_SUBPROTOCOL, o.token]);
  } catch {
    // e.g. SyntaxError "The subprotocol '<token>' is invalid." / bad URL: drop the message.
    return Promise.reject(new PipeError('cannotOpen'));
  }
  ws.binaryType = 'arraybuffer';

  const dataCbs: ((b: Uint8Array) => void)[] = [];
  const closeCbs: ((reason: string) => void)[] = [];
  const pending: Uint8Array[] = [];
  let closedReason: string | null = null;

  const finish = (reason: string) => {
    if (closedReason !== null) return;
    closedReason = reason;
    for (const cb of closeCbs.splice(0)) cb(reason);
  };

  const pipe: BytePipe = {
    send(b) {
      // Callers never pass SharedArrayBuffer-backed views.
      if (closedReason === null && ws.readyState === WebSocket.OPEN) ws.send(b as Uint8Array<ArrayBuffer>);
    },
    onData(cb) {
      dataCbs.push(cb);
      for (const b of pending.splice(0)) cb(b);
    },
    onClose(cb) {
      if (closedReason !== null) cb(closedReason);
      else closeCbs.push(cb);
    },
    close() {
      if (closedReason !== null) return;
      try {
        ws.close(1000);
      } catch {
        // already closing
      }
      finish('closed locally');
    },
  };

  return new Promise((resolve, reject) => {
    let opened = false;
    let aborted = false;
    o.signal?.addEventListener(
      'abort',
      () => {
        if (closedReason !== null) return;
        if (!opened) {
          aborted = true;
          reject(new PipeError('aborted'));
        }
        pipe.close();
      },
      { once: true },
    );
    ws.onopen = () => {
      if (aborted || closedReason !== null) return;
      opened = true;
      resolve(pipe);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (closedReason !== null) return;
      if (!(e.data instanceof ArrayBuffer)) {
        try {
          ws.close(1003);
        } catch {
          // ignore
        }
        finish('unexpected text message');
        return;
      }
      const bytes = new Uint8Array(e.data);
      if (dataCbs.length === 0) pending.push(bytes);
      else for (const cb of dataCbs) cb(bytes);
    };
    ws.onerror = () => {
      // A close event always follows; it carries the code.
    };
    ws.onclose = (e: CloseEvent) => {
      if (!opened && !aborted) reject(new PipeError(e.code, e.reason));
      finish(describeClose(e.code, e.reason));
    };
  });
}
