// Production transport for RelaySession: WebSocket pipe through the Worker (no token) to
// ip:443, then in-browser TLS with SNI "ultraviewer" and the certificate checked against `certName`.
import { openPipe as defaultOpenPipe, PipeError, type BytePipe, type PipeOptions } from '../net/pipe';
import { openTls as defaultOpenTls, type TlsChannel, type TlsOptions } from '../net/tls';
import type { RelaySessionDeps } from './relay-session';

export interface WorkerChannelOptions {
  workerUrl: string;
  /** Test hooks. */
  openPipe?: (o: PipeOptions) => Promise<BytePipe>;
  openTls?: (pipe: BytePipe, o: TlsOptions) => Promise<TlsChannel>;
}

export function workerChannelOpener(o: WorkerChannelOptions): RelaySessionDeps['openChannel'] {
  const openPipe = o.openPipe ?? defaultOpenPipe;
  const openTls = o.openTls ?? defaultOpenTls;
  // `signal` aborts only an attempt the session has abandoned (timeout); it is never fired
  // after this resolves. Every abandoned attempt closes its pipe, releasing the Worker lease.
  return async (ip, certName, signal) => {
    const pipe = await openPipe({ workerUrl: o.workerUrl, ip, port: 443, signal });
    if (signal?.aborted) {
      pipe.close();
      throw new PipeError('aborted');
    }
    let settled = false;
    let abort: Promise<never> | null = null;
    if (signal) {
      abort = new Promise<never>((_, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            if (settled) return; // a channel already handed out is never torn down from here
            pipe.close();
            reject(new PipeError('aborted'));
          },
          { once: true },
        ),
      );
      abort.catch(() => {}); // only observed through the race below
    }
    try {
      const tls = openTls(pipe, { sni: 'ultraviewer', certName });
      const channel = await (abort ? Promise.race([tls, abort]) : tls);
      settled = true;
      return channel;
    } catch (e) {
      settled = true;
      pipe.close();
      throw e;
    }
  };
}
