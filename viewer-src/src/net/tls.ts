// TLS client (node-forge: TLS 1.0/1.1, RSA + AES-CBC-SHA) running over a BytePipe.
// The relay speaks TLS 1.0-1.2 and accepts TLS 1.1 + AES256-SHA. Certificates are judged
// only by checkServerChain (expired accepted, name + chain enforced); forge's own verdict
// is ignored. Callers depend on ByteChannel, so this can be swapped for another TLS stack.
import forge from 'node-forge';
import type { BytePipe } from './pipe';
import { checkServerChain, checkServerChainWith, type ChainCheck } from './trust';

export interface ByteChannel extends BytePipe {}

export interface TlsChannel extends ByteChannel {
  /** The passing chain check (diagnostics: "cert expired: true"). */
  readonly chainCheck: Extract<ChainCheck, { ok: true }>;
  readonly expired: boolean;
}

export type TlsErrorCode = 'untrusted' | 'name' | 'parse' | 'handshake' | 'closed';

export class TlsError extends Error {
  readonly code: TlsErrorCode;
  constructor(code: TlsErrorCode, message: string = code) {
    super(message);
    this.name = 'TlsError';
    this.code = code;
  }
}

export interface TlsOptions {
  sni: 'ultraviewer';
  certName: string;
  now?: () => Date;
  /** Default 20 s. */
  handshakeTimeoutMs?: number;
  /** Test hook: DER anchors replacing the bundled ones. */
  trustAnchors?: Uint8Array[];
}

const CIPHER_SUITES = [
  forge.tls.CipherSuites.TLS_RSA_WITH_AES_256_CBC_SHA!,
  forge.tls.CipherSuites.TLS_RSA_WITH_AES_128_CBC_SHA!,
];

const toBinary = (b: Uint8Array): string => forge.util.binary.raw.encode(b);
const fromBinary = (s: string): Uint8Array => forge.util.binary.raw.decode(s);

export function openTls(pipe: BytePipe, o: TlsOptions): Promise<TlsChannel> {
  return new Promise((resolve, reject) => {
    const dataCbs: ((b: Uint8Array) => void)[] = [];
    const closeCbs: ((reason: string) => void)[] = [];
    let check: ChainCheck | null = null;
    let connected = false;
    let closedReason: string | null = null;
    let closingLocally = false;

    const shutdown = (reason: string, error: TlsError | null) => {
      if (closedReason !== null) return;
      closedReason = reason;
      clearTimeout(timer);
      pipe.close();
      if (!connected) reject(error ?? new TlsError('closed', reason));
      for (const cb of closeCbs.splice(0)) cb(reason);
    };

    const timer = setTimeout(
      () => shutdown('TLS handshake timed out', new TlsError('handshake', 'TLS handshake timed out')),
      o.handshakeTimeoutMs ?? 20_000,
    );

    const conn = forge.tls.createConnection({
      server: false,
      sessionId: null,
      virtualHost: o.sni,
      cipherSuites: CIPHER_SUITES,
      // Called once per certificate (leaf first). Decide once, on the whole served chain.
      verify: (_c, _forgeVerdict, depth, certs) => {
        if (depth === 0 || check === null) {
          const chainDer = certs.map((c) => fromBinary(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes()));
          const now = o.now?.() ?? new Date();
          check = o.trustAnchors
            ? checkServerChainWith(chainDer, o.certName, now, o.trustAnchors)
            : checkServerChain(chainDer, o.certName, now);
        }
        if (check.ok) return true;
        return { message: `certificate rejected: ${check.reason}`, alert: forge.tls.Alert.Description.bad_certificate };
      },
      connected: () => {
        if (closedReason !== null || check === null || !check.ok) return;
        connected = true;
        clearTimeout(timer);
        const chainCheck = check;
        resolve({
          chainCheck,
          expired: chainCheck.expired,
          send(b) {
            if (closedReason === null) conn.prepare(toBinary(b));
          },
          onData(cb) {
            dataCbs.push(cb);
          },
          onClose(cb) {
            if (closedReason !== null) cb(closedReason);
            else closeCbs.push(cb);
          },
          close() {
            if (closedReason !== null) return;
            closingLocally = true;
            conn.close(); // sends close_notify via tlsDataReady, then calls `closed`
            shutdown('closed locally', null);
          },
        });
      },
      tlsDataReady: (c) => {
        const bytes = c.tlsData.getBytes();
        if (bytes.length > 0) pipe.send(fromBinary(bytes));
      },
      dataReady: (c) => {
        const bytes = c.data.getBytes();
        if (bytes.length === 0) return;
        const chunk = fromBinary(bytes);
        for (const cb of dataCbs) cb(chunk);
      },
      closed: () => shutdown(closingLocally ? 'closed locally' : 'TLS closed by peer', null),
      error: (_c, ex) => {
        const code: TlsErrorCode = check !== null && !check.ok ? check.reason : 'handshake';
        shutdown(`TLS error: ${ex.message}`, new TlsError(code, ex.message || code));
      },
    });

    pipe.onData((b) => {
      if (closedReason === null) conn.process(toBinary(b));
    });
    pipe.onClose((reason) => shutdown(reason, new TlsError('closed', `pipe closed before TLS completed: ${reason}`)));
    conn.handshake();
  });
}
