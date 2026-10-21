// WebSocket to the Cloudflare Worker (`GET /tcp?ip=&port=`) exposed as a raw byte pipe.
// No token: the Worker is open (owner decision 2026-10-21); the browser only offers the
// `uvpipe` subprotocol, which the Worker echoes.

export interface BytePipe {
  send(b: Uint8Array): void;
  onData(cb: (b: Uint8Array) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

export type PipeErrorCode =
  /** The socket closed before the upgrade completed (`closeCode` says why). */
  | 'closedBeforeOpen'
  /** The WebSocket constructor threw (bad Worker URL); its message is not kept. */
  | 'cannotOpen'
  /** The caller's AbortSignal fired before the socket opened. */
  | 'aborted';

const FIXED_MESSAGES: Record<Exclude<PipeErrorCode, 'closedBeforeOpen'>, string> = {
  cannotOpen: 'worker WebSocket could not be created (check the Worker URL)',
  aborted: 'worker pipe attempt abandoned',
};

export class PipeError extends Error {
  readonly code: PipeErrorCode;
  /** WebSocket close code (4403 forbidden target, 4429 too many, 4502 connect failed, 1006 network); 0 when no socket closed. */
  readonly closeCode: number;
  constructor(closeCode: number, reason: string);
  constructor(code: Exclude<PipeErrorCode, 'closedBeforeOpen'>);
  constructor(a: number | Exclude<PipeErrorCode, 'closedBeforeOpen'>, reason = '') {
    // Messages are fixed strings or Worker close reasons: fixed text only.
    super(typeof a === 'number' ? `worker pipe closed before open: ${describeClose(a, reason)}` : FIXED_MESSAGES[a]);
    this.name = 'PipeError';
    this.code = typeof a === 'number' ? 'closedBeforeOpen' : a;
    this.closeCode = typeof a === 'number' ? a : 0;
  }
}

export const PIPE_SUBPROTOCOL = 'uvpipe';

function describeClose(code: number, reason: string): string {
  return reason ? `${code} ${reason}` : String(code);
}

export interface PipeOptions {
  workerUrl: string;
  ip: string;
  port: 443;
  /** Abandons the attempt: closes the socket (before or after open) so the Worker lease is freed. */
  signal?: AbortSignal;
}

/**
 * Note: the Worker completes the upgrade before rejecting (so the close code is readable),
 * so a refused target (4403) or limit (4429) usually resolves here and then closes — watch `onClose`.
 * Never throws synchronously; every failure is a rejected PipeError.
 */
export function openPipe(o: PipeOptions): Promise<BytePipe> {
  if (o.signal?.aborted) return Promise.reject(new PipeError('aborted'));
  const url = `${o.workerUrl.replace(/\/+$/, '')}/tcp?ip=${encodeURIComponent(o.ip)}&port=${o.port}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, [PIPE_SUBPROTOCOL]);
  } catch {
    // e.g. a bad Worker URL (SyntaxError): drop the message.
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
