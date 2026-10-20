/// <reference types="vite/client" />
// Server certificate check for the relay TLS connection, mirroring MacViewer's
// FramedTCPTransport.verify: the chain must reach a bundled trust anchor and the leaf must
// name `certName`; an expired (or not-yet-valid) certificate is accepted and only reported.
import forge from 'node-forge';
import { binaryToBytes, bytesToBinary } from './binary';
import aaaPem from '../../fixtures/roots/aaa-certificate-services.pem?raw';
import r46Pem from '../../fixtures/roots/sectigo-r46.pem?raw';
import usertrustPem from '../../fixtures/roots/usertrust-rsa.pem?raw';

export type ChainCheck = { ok: true; expired: boolean } | { ok: false; reason: 'untrusted' | 'name' | 'parse' };

const MAX_PATH = 8;

interface Parsed {
  der: string; // binary string, used for identity
  cert: forge.pki.Certificate;
  subject: string;
  issuer: string;
  key: string; // DER of SubjectPublicKeyInfo
}

/** All certificates in a PEM bundle, as DER. Non-certificate blocks are skipped. */
export function pemToDer(pem: string): Uint8Array[] {
  return forge.pem
    .decode(pem)
    .filter((m) => m.type === 'CERTIFICATE')
    .map((m) => binaryToBytes(m.body));
}

let anchorsCache: Uint8Array[] | null = null;

/** Sectigo Public Server Authentication Root R46, USERTrust RSA CA, AAA Certificate Services. */
export function defaultAnchors(): Uint8Array[] {
  anchorsCache ??= [r46Pem, usertrustPem, aaaPem].flatMap(pemToDer);
  return anchorsCache;
}

export function checkServerChain(chainDer: Uint8Array[], certName: string, now: Date): ChainCheck {
  return checkServerChainWith(chainDer, certName, now, defaultAnchors());
}

/** `checkServerChain` with explicit anchors (DER). `now` only decides `expired`. */
export function checkServerChainWith(
  chainDer: Uint8Array[],
  certName: string,
  now: Date,
  anchorsDer: Uint8Array[],
): ChainCheck {
  const [leafDer, ...restDer] = chainDer;
  const leaf = leafDer === undefined ? null : parse(leafDer);
  if (leaf === null) return { ok: false, reason: 'parse' };
  // Extra certificates that cannot be parsed (e.g. a non-RSA key forge cannot read) are just unusable.
  const served = restDer.map(parse).filter((p): p is Parsed => p !== null);
  const anchors = anchorsDer.map(parse).filter((p): p is Parsed => p !== null);

  if (!leafAllowsServerAuth(leaf.cert)) return { ok: false, reason: 'untrusted' };
  const path = buildPath([leaf], served, anchors);
  if (path === null) return { ok: false, reason: 'untrusted' };
  if (!leafNames(leaf.cert).some((pattern) => hostnameMatches(pattern, certName))) {
    return { ok: false, reason: 'name' };
  }
  const t = now.getTime();
  const expired = path.some(
    (p) => t < p.cert.validity.notBefore.getTime() || t > p.cert.validity.notAfter.getTime(),
  );
  return { ok: true, expired };
}

function parse(der: Uint8Array): Parsed | null {
  try {
    const raw = bytesToBinary(der);
    const cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(raw, true), true);
    return {
      der: raw,
      cert,
      subject: String(cert.subject.hash),
      issuer: String(cert.issuer.hash),
      key: forge.asn1.toDer(forge.pki.publicKeyToAsn1(cert.publicKey)).getBytes(),
    };
  } catch {
    return null;
  }
}

/**
 * Depth-first search from the leaf through served certificates and anchors. A certificate
 * (other than the leaf) that matches an anchor by subject + public key ends the path, so a
 * served cross-certificate (USERTrust issued by AAA) terminates at the self-signed USERTrust
 * anchor as well as continuing on to AAA.
 */
function buildPath(path: Parsed[], served: Parsed[], anchors: Parsed[]): Parsed[] | null {
  const current = path[path.length - 1]!;
  if (path.length > 1 && anchors.some((a) => a.subject === current.subject && a.key === current.key)) {
    return path;
  }
  if (path.length >= MAX_PATH) return null;
  for (const candidate of [...served, ...anchors]) {
    if (candidate.subject !== current.issuer) continue;
    if (path.some((p) => p.der === candidate.der)) continue;
    if (!canIssue(candidate.cert, path.length - 1)) continue;
    if (!signs(candidate.cert, current.cert)) continue;
    const found = buildPath([...path, candidate], served, anchors);
    if (found !== null) return found;
  }
  return null;
}

/** `intermediatesBelow`: CA certificates between this issuer and the leaf. */
function canIssue(cert: forge.pki.Certificate, intermediatesBelow: number): boolean {
  const bc = cert.getExtension('basicConstraints') as { cA?: boolean; pathLenConstraint?: number } | null;
  if (bc === null || bc.cA !== true) return false;
  if (typeof bc.pathLenConstraint === 'number' && intermediatesBelow > bc.pathLenConstraint) return false;
  const ku = cert.getExtension('keyUsage') as { keyCertSign?: boolean } | null;
  return ku === null || ku.keyCertSign === true;
}

function signs(issuer: forge.pki.Certificate, child: forge.pki.Certificate): boolean {
  try {
    return issuer.verify(child);
  } catch {
    return false; // unsupported algorithm, issuer/subject mismatch, bad signature
  }
}

function leafAllowsServerAuth(cert: forge.pki.Certificate): boolean {
  const eku = cert.getExtension('extKeyUsage') as { serverAuth?: boolean } | null;
  return eku === null || eku.serverAuth === true;
}

/** DNS names from subjectAltName only (no CN fallback, as in current browser/Apple policy). */
function leafNames(cert: forge.pki.Certificate): string[] {
  const san = cert.getExtension('subjectAltName') as { altNames?: { type: number; value?: string }[] } | null;
  return (san?.altNames ?? []).filter((n) => n.type === 2 && typeof n.value === 'string').map((n) => n.value!);
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

/** RFC 6125: a wildcard is the entire left-most label, matches exactly one label, and needs 2+ labels after it. */
export function hostnameMatches(pattern: string, name: string): boolean {
  const p = normalize(pattern);
  const n = normalize(name);
  if (n === '' || n.includes('*') || n.startsWith('.') || n.includes('..')) return false;
  if (!p.startsWith('*.')) return p === n;
  const base = p.slice(2);
  if (base.includes('*') || base.split('.').length < 2) return false;
  const dot = n.indexOf('.');
  return dot > 0 && n.slice(dot + 1) === base;
}
