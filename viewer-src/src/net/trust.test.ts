import { describe, expect, test } from 'vitest';
import forge from 'node-forge';
import { checkServerChain, checkServerChainWith, defaultAnchors } from './trust';
import { certToDer, makeCert, pemChain, selfSignedFor } from './test-certs';

const chain = pemChain('fixtures/relay-chain.pem');
const [leaf, sectigoDv, usertrustCross] = chain as [Uint8Array, Uint8Array, Uint8Array];
const r46 = pemChain('fixtures/roots/sectigo-r46.pem');
const usertrustRoot = pemChain('fixtures/roots/usertrust-rsa.pem');
const aaa = pemChain('fixtures/roots/aaa-certificate-services.pem');

describe('checkServerChain (brief)', () => {
  test('accepts the real, expired relay chain for its name', () =>
    expect(checkServerChain(chain, 'functions3.ultraviewer.net', new Date('2026-10-20'))).toEqual({ ok: true, expired: true }));
  test('accepts bare domain from SAN', () =>
    expect(checkServerChain(chain, 'ultraviewer.net', new Date('2026-10-20')).ok).toBe(true));
  test('rejects wrong name', () =>
    expect(checkServerChain(chain, 'evil.example.com', new Date('2026-10-20'))).toEqual({ ok: false, reason: 'name' }));
  test('wildcard does not match two labels', () =>
    expect(checkServerChain(chain, 'a.b.ultraviewer.net', new Date())).toEqual({ ok: false, reason: 'name' }));
  test('rejects chain without its intermediates', () =>
    expect(checkServerChain([leaf], 'functions3.ultraviewer.net', new Date())).toEqual({ ok: false, reason: 'untrusted' }));
  test('accepts a leaf-only relay through the bundled DV R36 intermediate', () => {
    const [leafOnly] = pemChain('fixtures/relay-leaf-only-2026-11.pem') as [Uint8Array];
    const name = 'functions3.ultraviewer.net';
    const now = new Date('2026-10-21');
    expect(checkServerChain([leafOnly], name, now)).toEqual({ ok: true, expired: false });
    expect(checkServerChainWith([leafOnly], name, now, defaultAnchors())).toEqual({ ok: false, reason: 'untrusted' });
  });
  test('rejects self-signed leaf', () =>
    expect(checkServerChain([selfSignedFor('*.ultraviewer.net')], 'functions3.ultraviewer.net', new Date()).ok).toBe(false));
});

describe('checkServerChain (real chain, extra cases)', () => {
  const name = 'functions3.ultraviewer.net';

  test('bundles the three anchors', () => expect(defaultAnchors()).toHaveLength(3));

  test('expired is false while every certificate in the path is valid', () =>
    expect(checkServerChain(chain, name, new Date('2026-01-01T00:00:00Z'))).toEqual({ ok: true, expired: false }));

  test('expired flips one second after the leaf notAfter (validity never rejects)', () => {
    expect(checkServerChain(chain, name, new Date('2026-05-01T23:59:59Z'))).toEqual({ ok: true, expired: false });
    expect(checkServerChain(chain, name, new Date('2026-05-02T00:00:00Z'))).toEqual({ ok: true, expired: true });
    expect(checkServerChain(chain, name, new Date('2099-01-01'))).toEqual({ ok: true, expired: true });
  });

  test('name match is case-insensitive and ignores one trailing dot', () => {
    expect(checkServerChain(chain, 'Functions3.UltraViewer.NET', new Date()).ok).toBe(true);
    expect(checkServerChain(chain, 'functions3.ultraviewer.net.', new Date()).ok).toBe(true);
  });

  test.each(['ultraviewer.net.evil.com', 'xultraviewer.net', '.ultraviewer.net', '', 'ultraviewer', '*.ultraviewer.net'])(
    'rejects name %j',
    (bad) => expect(checkServerChain(chain, bad, new Date())).toEqual({ ok: false, reason: 'name' }),
  );

  test('chain order does not matter', () =>
    expect(checkServerChain([leaf, usertrustCross, sectigoDv], name, new Date()).ok).toBe(true));

  test('terminates at the self-signed USERTrust root when the cross-cert is not served', () =>
    expect(checkServerChainWith([leaf, sectigoDv], name, new Date(), usertrustRoot).ok).toBe(true));

  test('terminates at USERTrust when the served cross-cert matches it by subject + key', () =>
    expect(checkServerChainWith(chain, name, new Date(), usertrustRoot).ok).toBe(true));

  test('terminates at AAA via the cross-cert', () =>
    expect(checkServerChainWith(chain, name, new Date(), aaa).ok).toBe(true));

  test('AAA alone cannot anchor a chain missing the cross-cert', () =>
    expect(checkServerChainWith([leaf, sectigoDv], name, new Date(), aaa)).toEqual({ ok: false, reason: 'untrusted' }));

  test('R46 alone does not anchor this chain', () =>
    expect(checkServerChainWith(chain, name, new Date(), r46)).toEqual({ ok: false, reason: 'untrusted' }));

  test('no anchors => untrusted', () =>
    expect(checkServerChainWith(chain, name, new Date(), [])).toEqual({ ok: false, reason: 'untrusted' }));

  test('a tampered leaf signature is untrusted', () => {
    const bad = leaf.slice();
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0x01;
    expect(checkServerChain([bad, sectigoDv, usertrustCross], name, new Date())).toEqual({ ok: false, reason: 'untrusted' });
  });

  test('garbage leaf => parse', () =>
    expect(checkServerChain([new Uint8Array([0x30, 0x03, 0x01, 0x02, 0x03])], name, new Date())).toEqual({ ok: false, reason: 'parse' }));

  test('empty chain => parse', () => expect(checkServerChain([], name, new Date())).toEqual({ ok: false, reason: 'parse' }));

  test('an unparseable extra certificate is ignored', () =>
    expect(checkServerChain([...chain, new Uint8Array([1, 2, 3])], name, new Date()).ok).toBe(true));

  test('forge DER round-trip is byte-exact (the TLS verify callback relies on it)', () => {
    for (const der of chain) {
      const cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.binary.raw.encode(der)));
      expect(certToDer(cert)).toEqual(der);
    }
  });
});

describe('checkServerChainWith (synthetic PKI)', () => {
  const name = 'host.test';
  const root = makeCert({ cn: 'Test Root', ca: true });
  const anchors = [root.der];

  test('positive control: root -> CA intermediate -> leaf', () => {
    const mid = makeCert({ cn: 'Mid', issuer: root, ca: true });
    const leafT = makeCert({ cn: name, dns: [name], issuer: mid, serverAuth: true });
    expect(checkServerChainWith([leafT.der, mid.der], name, new Date(), anchors)).toEqual({ ok: true, expired: false });
  });

  test('rejects an intermediate whose basicConstraints cA is false', () => {
    const mid = makeCert({ cn: 'Mid', issuer: root, ca: false });
    const leafT = makeCert({ cn: name, dns: [name], issuer: mid });
    expect(checkServerChainWith([leafT.der, mid.der], name, new Date(), anchors)).toEqual({ ok: false, reason: 'untrusted' });
  });

  test('rejects an intermediate without basicConstraints', () => {
    const mid = makeCert({ cn: 'Mid', issuer: root });
    const leafT = makeCert({ cn: name, dns: [name], issuer: mid });
    expect(checkServerChainWith([leafT.der, mid.der], name, new Date(), anchors)).toEqual({ ok: false, reason: 'untrusted' });
  });

  test('enforces pathLenConstraint', () => {
    const mid1 = makeCert({ cn: 'Mid1', issuer: root, ca: true, pathLen: 0 });
    const mid2 = makeCert({ cn: 'Mid2', issuer: mid1, ca: true });
    const leafT = makeCert({ cn: name, dns: [name], issuer: mid2 });
    expect(checkServerChainWith([leafT.der, mid2.der, mid1.der], name, new Date(), anchors)).toEqual({ ok: false, reason: 'untrusted' });
  });

  test('rejects a leaf issued by a lookalike CA (same name, different key)', () => {
    const fakeRoot = makeCert({ cn: 'Test Root', ca: true });
    const leafT = makeCert({ cn: name, dns: [name], issuer: fakeRoot });
    expect(checkServerChainWith([leafT.der, fakeRoot.der], name, new Date(), anchors)).toEqual({ ok: false, reason: 'untrusted' });
  });

  test('rejects a leaf whose EKU excludes serverAuth', () => {
    const leafT = makeCert({ cn: name, dns: [name], issuer: root, serverAuth: false });
    expect(checkServerChainWith([leafT.der], name, new Date(), anchors)).toEqual({ ok: false, reason: 'untrusted' });
  });

  test('ignores CN when SAN is absent (SAN is required)', () => {
    const leafT = makeCert({ cn: name, issuer: root });
    expect(checkServerChainWith([leafT.der], name, new Date(), anchors)).toEqual({ ok: false, reason: 'name' });
  });

  test('an expired intermediate and a not-yet-valid leaf are both reported as expired, not rejected', () => {
    const mid = makeCert({ cn: 'Mid', issuer: root, ca: true, notAfter: new Date('2020-01-01') });
    const leafT = makeCert({ cn: name, dns: [name], issuer: mid, notBefore: new Date('2090-01-01'), notAfter: new Date('2091-01-01') });
    expect(checkServerChainWith([leafT.der, mid.der], name, new Date(), anchors)).toEqual({ ok: true, expired: true });
  });

  test('wildcard must be the whole left-most label and needs two labels after it', () => {
    const partial = makeCert({ cn: 'x', dns: ['f*.test.example'], issuer: root });
    expect(checkServerChainWith([partial.der], 'foo.test.example', new Date(), anchors)).toEqual({ ok: false, reason: 'name' });
    const broad = makeCert({ cn: 'x', dns: ['*.example'], issuer: root });
    expect(checkServerChainWith([broad.der], 'foo.example', new Date(), anchors)).toEqual({ ok: false, reason: 'name' });
    const good = makeCert({ cn: 'x', dns: ['*.test.example'], issuer: root });
    expect(checkServerChainWith([good.der], 'foo.test.example', new Date(), anchors).ok).toBe(true);
    expect(checkServerChainWith([good.der], 'test.example', new Date(), anchors)).toEqual({ ok: false, reason: 'name' });
  });
});
