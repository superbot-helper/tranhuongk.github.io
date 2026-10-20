// Production transport for RelaySession: WebSocket pipe through the Worker (token only in
// Sec-WebSocket-Protocol) to ip:443, then in-browser TLS with SNI "ultraviewer" and the
// certificate checked against `certName`.
import { openPipe as defaultOpenPipe, type BytePipe } from '../net/pipe';
import { openTls as defaultOpenTls, type TlsChannel, type TlsOptions } from '../net/tls';
import type { RelaySessionDeps } from './relay-session';

export interface WorkerChannelOptions {
  workerUrl: string;
  token: string;
  /** Test hooks. */
  openPipe?: (o: { workerUrl: string; token: string; ip: string; port: 443 }) => Promise<BytePipe>;
  openTls?: (pipe: BytePipe, o: TlsOptions) => Promise<TlsChannel>;
}

export function workerChannelOpener(o: WorkerChannelOptions): RelaySessionDeps['openChannel'] {
  const openPipe = o.openPipe ?? defaultOpenPipe;
  const openTls = o.openTls ?? defaultOpenTls;
  return async (ip, certName) => {
    const pipe = await openPipe({ workerUrl: o.workerUrl, token: o.token, ip, port: 443 });
    try {
      return await openTls(pipe, { sni: 'ultraviewer', certName });
    } catch (e) {
      pipe.close();
      throw e;
    }
  };
}
