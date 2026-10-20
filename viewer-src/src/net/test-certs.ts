// Test-only certificate helpers. Not imported by production code.
import { readFileSync } from 'node:fs';
import forge from 'node-forge';
import { pemToDer } from './trust';

/** DER certificates from a PEM file under viewer-src/ (path relative to viewer-src). */
export function pemChain(path: string): Uint8Array[] {
  return pemToDer(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
}

export function certToDer(cert: forge.pki.Certificate): Uint8Array {
  return forge.util.binary.raw.decode(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
}

export interface TestCert {
  cert: forge.pki.Certificate;
  der: Uint8Array;
  keys: forge.pki.rsa.KeyPair;
  pem: string;
  keyPem: string;
}

export interface CertSpec {
  cn: string;
  /** DNS SANs; omitted => no subjectAltName extension. */
  dns?: string[];
  /** Signing CA; omitted => self-signed. */
  issuer?: TestCert;
  /** basicConstraints cA; undefined => no basicConstraints extension. */
  ca?: boolean;
  pathLen?: number;
  notBefore?: Date;
  notAfter?: Date;
  serverAuth?: boolean;
}

let serial = 1;
// 1024-bit keys keep pure-JS key generation fast; strength is irrelevant in tests.
function freshKeys(): forge.pki.rsa.KeyPair {
  return forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
}

export function makeCert(spec: CertSpec): TestCert {
  const keys = freshKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = (serial++).toString(16).padStart(2, '0');
  cert.validity.notBefore = spec.notBefore ?? new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = spec.notAfter ?? new Date(Date.now() + 365 * 86_400_000);
  const subject = [{ name: 'commonName', value: spec.cn }];
  cert.setSubject(subject);
  cert.setIssuer(spec.issuer ? spec.issuer.cert.subject.attributes : subject);
  const extensions: object[] = [];
  if (spec.ca !== undefined) {
    extensions.push({
      name: 'basicConstraints',
      cA: spec.ca,
      critical: true,
      ...(spec.pathLen !== undefined ? { pathLenConstraint: spec.pathLen } : {}),
    });
    if (spec.ca) extensions.push({ name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true });
  }
  if (spec.dns) extensions.push({ name: 'subjectAltName', altNames: spec.dns.map((value) => ({ type: 2, value })) });
  if (spec.serverAuth !== undefined) extensions.push({ name: 'extKeyUsage', serverAuth: spec.serverAuth, clientAuth: true });
  cert.setExtensions(extensions);
  cert.sign(spec.issuer ? spec.issuer.keys.privateKey : keys.privateKey, forge.md.sha256.create());
  return {
    cert,
    der: certToDer(cert),
    keys,
    pem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export function selfSignedFor(cn: string): Uint8Array {
  return makeCert({ cn, dns: [cn], ca: true }).der;
}
