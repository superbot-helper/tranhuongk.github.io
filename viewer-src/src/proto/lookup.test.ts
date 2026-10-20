import { describe, expect, test } from 'vitest';
import {
  PeerLookupError,
  lookupBytes,
  lookupText,
  parseLookupReply,
  type LookupRequest,
} from './lookup';
import { enc, expectError } from './test-utils';

function lookupFixture(): LookupRequest {
  return {
    targetID: 'peer-17', credential: { kind: 'password', value: 'peer-pass' },
    clientVersion: '6.6.133', licenseContext: 'lic-a', additionalLicenseContext: 'lic-b',
    localID: 'local-42', localPassword: 'self-pass', targetSessionID: -1,
    correlationNumber: 42, isReconnect: false, referralIDText: '1.5',
    paymentTypeText: 'free', dateTimeOffsetMinutes: 420, objectDictionaryCount: 2,
    fixedPingList: '',
  };
}

// Ported from PeerLookupTests.swift (vectors unchanged). The DirectDetails (LAN direct) half of
// lookupDirectDetailsAndVerbatimCredentialPreserveNativeSeparators is not ported: the web viewer never sends it.
describe('peer lookup (PeerLookupTests.swift)', () => {
  test('lookupRequestMatchesIndependentPlaintextFixture', () => {
    // Proofs independently computed with Python hashlib from the recovered input order.
    const expected = '8:peer-17:e3f326c385d2606a12a2d77260e3e81d:6.6.133:lic-a:lic-b:local-42:206a9ce1ea16f69943378fed8366ca11:-1:42:0:1.5:free:420:2::';
    expect(lookupBytes(lookupFixture())).toEqual(enc(expected));
    expect(lookupText(lookupFixture())).toBe(expected);
    expect(expected.split(':').length).toBe(17);
  });

  test('lookupVerbatimCredentialAndReconnectPreserveNativeFields', () => {
    const request: LookupRequest = { ...lookupFixture(), credential: { kind: 'verbatim', value: 'opaque-token' }, isReconnect: true };
    const fields = lookupText(request).split(':');
    expect(fields[2]).toBe('opaque-token');
    expect(fields[10]).toBe('-1');
    expect(fields[16]).toBe('');
  });

  test('lookupReplyExtractsContextWithoutTreatingLookupAsAuthentication', () => {
    const text = '8:1:192.0.2.9:unused:203.0.113.9:54000:5900:5901:TmFtZQ==:55100:unused:198.51.100.2:-1:123:relay.example:x:x:x:x:x:secret:direct-info:42';
    const reply = parseLookupReply(enc(text));
    expect(reply.correlationNumber).toBe(42);
    const peer = reply.peerInfo();
    expect(peer).not.toBeNull();
    expect(peer!.publicIP).toBe('203.0.113.9');
    expect(peer!.publicPort).toBe(54000);
    expect(peer!.lanIP).toBe('192.0.2.9');
    expect(peer!.lanPort).toBe(5900);
    expect(peer!.relayIP).toBe('198.51.100.2');
    expect(peer!.targetTCPPort).toBe(55100);
    expect(peer!.commandPort).toBe(5901);
    expect(peer!.targetSessionID).toBe(123);
    expect(peer!.matchedCustomPassword).toBe(-1);
    expect(peer!.computerNameField).toBe('TmFtZQ==');
    expect(peer!.relayHostname).toBe('relay.example');
    expect(peer!.partnerSecretToken).toBe('secret');
    expect(peer!.directDetailsField).toBe('direct-info');
    expect(reply.fields[3]).toBe('unused');
    expect(reply.status).toBe(1);
    expect(parseLookupReply(enc('8:2:42')).peerInfo()).toBeNull();
  });

  test('optional suffix fields are null when absent, correlation null when not numeric', () => {
    const text = '8:1:192.0.2.9:unused:203.0.113.9:54000:5900:5901:TmFtZQ==:55100:unused:198.51.100.2:-1:123:relay.example';
    const reply = parseLookupReply(enc(text));
    const peer = reply.peerInfo()!;
    expect(peer.partnerSecretToken).toBeNull();
    expect(peer.directDetailsField).toBeNull();
    expect(reply.correlationNumber).toBeNull(); // last field "relay.example"
    expect(parseLookupReply(enc('8:2:')).correlationNumber).toBeNull();
  });

  test('lookupRejectsMalformedFieldsAndKeepsPasswordsOutOfPlaintext', () => {
    expectError(() => lookupBytes({ ...lookupFixture(), targetID: 'injected:field' }), PeerLookupError, 'invalidField');
    expectError(
      () => lookupBytes({ ...lookupFixture(), credential: { kind: 'password', value: 'é' } }),
      PeerLookupError, 'unsupportedEncoding');
    expectError(() => parseLookupReply(enc('8:1')).peerInfo(), PeerLookupError, 'invalidReply');
    expectError(() => parseLookupReply(enc('3:1:42')), PeerLookupError, 'invalidReply');
    // The plaintext carries only MD5 proofs, never either password.
    const text = lookupText(lookupFixture());
    expect(text).not.toContain('peer-pass');
    expect(text).not.toContain('self-pass');
  });

  test('reply budgets, encoding and number errors', () => {
    expectError(() => parseLookupReply(new Uint8Array(65537)), PeerLookupError, 'payloadTooLarge');
    expectError(() => parseLookupReply(new Uint8Array([56, 58, 49, 0])), PeerLookupError, 'unsupportedEncoding');
    expectError(() => parseLookupReply(enc(Array(129).fill('8').join(':'))), PeerLookupError, 'invalidReply');
    expectError(() => parseLookupReply(enc('8:x')), PeerLookupError, 'invalidReply');
    const fields = '8:1:192.0.2.9:unused:203.0.113.9:54000:5900:5901:TmFtZQ==:55100:unused:198.51.100.2:-1:123:relay.example'.split(':');
    const bad = (index: number, value: string) => {
      const copy = [...fields];
      copy[index] = value;
      try {
        parseLookupReply(enc(copy.join(':'))).peerInfo();
      } catch (e) {
        return e as PeerLookupError;
      }
      throw new Error('expected throw');
    };
    for (const index of [5, 6, 7, 9, 13]) {
      const e = bad(index, 'nope');
      expect(e).toBeInstanceOf(PeerLookupError);
      expect(e.code).toBe('invalidNumber');
      expect(e.field).toBe(index);
    }
    expect(bad(12, '40000').code).toBe('invalidNumber'); // Int16 overflow
    expect(bad(12, '40000').field).toBe(12);
    expect(bad(9, '2147483648').code).toBe('invalidNumber'); // Int32 overflow
  });

  test('request payload budget is 65536 bytes', () => {
    expectError(
      () => lookupText({ ...lookupFixture(), fixedPingList: 'x'.repeat(65536) }), PeerLookupError, 'payloadTooLarge');
  });
});
