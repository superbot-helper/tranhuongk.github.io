// Phase-0 connectivity probe: DoH -> Worker pipe -> TLS (SNI "ultraviewer") -> HTTP preamble.
// Shared by the spike page button and the LIVE test. 
import { resolveIPv4 } from '../net/dns';
import { openPipe } from '../net/pipe';
import { openTls } from '../net/tls';
import { httpPreamble, PreambleDecoder } from '../proto/envelope';

export const COMMAND_HOST = 'functions3.ultraviewer.net';

export interface ProbeResult {
  ip: string;
  expired: boolean;
  headerReceived: boolean;
  status: number | null;
}

export async function probeCommandTls(o: {
  workerUrl: string;
  log: (line: string) => void;
  host?: string;
  /** Use this relay IP instead of the first A record (diagnostics: relays serve different certs). */
  ip?: string;
  headerTimeoutMs?: number;
}): Promise<ProbeResult> {
  const host = o.host ?? COMMAND_HOST;
  o.log(`resolve ${host}`);
  const ips = await resolveIPv4(host);
  const ip = o.ip ?? ips[0];
  if (ip === undefined) throw new Error(`no A record for ${host}`);
  o.log(`A: ${ips.join(', ')} -> using ${ip}`);

  const pipe = await openPipe({ workerUrl: o.workerUrl, ip, port: 443 });
  o.log('worker pipe open');
  const tls = await openTls(pipe, { sni: 'ultraviewer', certName: host });
  o.log(`TLS OK (cert expired: ${tls.expired})`);

  const decoder = new PreambleDecoder();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no HTTP header from relay')), o.headerTimeoutMs ?? 15_000);
      tls.onData((chunk) => {
        try {
          decoder.push(chunk);
        } catch (e) {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        if (decoder.hasReceivedHeader) {
          clearTimeout(timer);
          resolve();
        }
      });
      tls.onClose((reason) => {
        clearTimeout(timer);
        reject(new Error(`closed before HTTP header: ${reason}`));
      });
      tls.send(httpPreamble(host));
      o.log('HTTP preamble sent');
    });
  } finally {
    tls.close();
  }
  o.log(`HTTP header received (status ${decoder.responseStatusCode ?? 'n/a'})`);
  return { ip, expired: tls.expired, headerReceived: decoder.hasReceivedHeader, status: decoder.responseStatusCode };
}
