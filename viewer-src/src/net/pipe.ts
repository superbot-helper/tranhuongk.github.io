// WebSocket to the Cloudflare Worker (`GET /tcp?ip=&port=`) exposed as a raw byte pipe.
// The access token travels only in Sec-WebSocket-Protocol, never in the URL.

export interface BytePipe {
  send(b: Uint8Array): void;
  onData(cb: (b: Uint8Array) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

export class PipeError extends Error {
  readonly code: 'closedBeforeOpen';
  /** WebSocket close code (4401 bad token, 4403 forbidden target, 4429 too many, 4502 connect failed, 1006 network). */
  readonly closeCode: number;
  constructor(closeCode: number, reason: string) {
    super(`worker pipe closed before open: ${describeClose(closeCode, reason)}`);
    this.name = 'PipeError';
    this.code = 'closedBeforeOpen';
    this.closeCode = closeCode;
  }
}

export const PIPE_SUBPROTOCOL = 'uvpipe';

function describeClose(code: number, reason: string): string {
  return reason ? `${code} ${reason}` : String(code);
}

/**
 * Note: the Worker completes the upgrade before rejecting (so the close code is readable),
 * so a bad token usually resolves here and then closes with 4401 — watch `onClose`.
 */
export function openPipe(o: { workerUrl: string; token: string; ip: string; port: 443 }): Promise<BytePipe> {
  const url = `${o.workerUrl.replace(/\/+$/, '')}/tcp?ip=${encodeURIComponent(o.ip)}&port=${o.port}`;
  const ws = new WebSocket(url, [PIPE_SUBPROTOCOL, o.token]);
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
    ws.onopen = () => {
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
      if (!opened) reject(new PipeError(e.code, e.reason));
      finish(describeClose(e.code, e.reason));
    };
  });
}
