import { describe, expect, test } from 'vitest';
import { LegacyCommandCipher } from './crypto';
import { RelayIPv4AddressError } from './envelope';
import {
  RegistrationError,
  parseRegistrationReply,
  registrationBytes,
  registrationEnvelope,
  registrationFramed,
  registrationText,
  type RegistrationRequest,
} from './registration';
import { enc, expectError } from './test-utils';

function syntheticRegistrationRequest(): RegistrationRequest {
  return {
    deviceIdentity: '0123456789ABCDEF0123456789ABCDEF', password: '654321',
    localAddress: '192.0.2.10',
    computerNameUTF8Base64: 'TWFj', clientVersion: '6.6.124', macAddress: '001122334455',
    diskIdentity: 'disk:serial', operatingSystem: 'synthetic-os', installerReferral: 0,
    customPassword: '', usesProxy: true, quickSupportMetadata: '', userNameWireValue: 'dean',
    activeSessionID: 1, processSessionID: 2, preferredIDText: '0', referralIDText: '0',
    automaticUpdate: -1, systemFolderCreationTicks: '638000000000000000',
    programFilesCreationTicks: '638000000000000001', systemVolumeInformationCreationTicks: '0',
    licenseContext1: 'license-A', licenseContext2: 'license-B', captchaToken: '',
  };
}

function expectRegistrationError(fn: () => unknown, code: string, field?: number): void {
  expectError(fn, RegistrationError, code);
  if (field !== undefined) {
    try { fn(); } catch (e) { expect((e as RegistrationError).field).toBe(field); }
  }
}

// Ported from ClientRegistrationTests.swift (vectors unchanged).
describe('registration request (ClientRegistrationTests.swift)', () => {
  test('registrationExactFieldsIncludeThreeFolderTimestamps', () => {
    const request = syntheticRegistrationRequest();
    // Independently transcribed from native concat 0x67dc74-0x67e018;
    // folder join 0x67d7b3-0x67d7eb contributes two additional colons.
    const expected = '3:0123456789ABCDEF0123456789ABCDEF:654321:0:192.0.2.10:0:' +
      'TWFj:6.6.124:001122334455:disk-serial:synthetic-os:0:::-1::dean:1:2:0:0:-1:' +
      '638000000000000000:638000000000000001:0:license-A:license-B:';
    expect(registrationText(request)).toBe(expected);
    expect(registrationBytes(request)).toEqual(enc(expected));
    const fields = expected.split(':');
    expect(fields.length).toBe(28);
    expect(fields[12]).toBe('');
    expect(fields.slice(22, 25)).toEqual(['638000000000000000', '638000000000000001', '0']);
    expect(fields[27]).toBe('');
    const exact = enc(expected).length;
    expect(registrationBytes(request, { maximumPayloadBytes: exact })).toEqual(enc(expected));
    expectRegistrationError(() => registrationBytes(request, { maximumPayloadBytes: exact - 1 }), 'payloadTooLarge');
  });

  test('registrationEnvelopeHasUnencryptedTCPV2FlagAndLELength', () => {
    const request = syntheticRegistrationRequest();
    request.usesProxy = false;
    request.captchaToken = 'captcha-result';
    const cipher = new LegacyCommandCipher('explicit-test-password');
    const envelope = registrationEnvelope(request, cipher);
    expect(Array.from(envelope.subarray(0, 2))).toEqual([1, 0]);
    expect(cipher.decrypt(envelope.slice(2))).toEqual(registrationBytes(request));
    const framed = registrationFramed(request, cipher);
    const length = new DataView(framed.buffer, framed.byteOffset).getUint32(0, true);
    expect(length).toBe(envelope.length);
    expect(framed.slice(4)).toEqual(envelope);
    const fields = registrationText(request).split(':');
    expect(fields[14]).toBe('0');
    expect(fields[27]).toBe('captcha-result');
  });

  test('registrationEnvelope defaults to the desktop server command cipher', () => {
    const request = syntheticRegistrationRequest();
    const withDefault = registrationEnvelope(request);
    const explicit = registrationEnvelope(request, new LegacyCommandCipher(String.fromCharCode(5, 10, 15, 20, 25)));
    expect(withDefault).toEqual(explicit);
  });

  test('registrationRejectsDelimiterInjectionAndUnverifiedCodePages', () => {
    const request = syntheticRegistrationRequest();
    request.licenseContext1 = 'extra:field';
    expectRegistrationError(() => registrationBytes(request), 'invalidField', 25);
    request.licenseContext1 = 'line\nbreak';
    expectRegistrationError(() => registrationBytes(request), 'invalidField', 25);
    request.licenseContext1 = 'opaque';
    request.userNameWireValue = 'café';
    expectRegistrationError(() => registrationBytes(request), 'unsupportedEncoding');
    expectRegistrationError(
      () => registrationBytes(syntheticRegistrationRequest(), { maximumPayloadBytes: -1 }), 'payloadTooLarge');
  });

  test('registrationProfileJSONRoundTrip (Codable analogue)', () => {
    const request = syntheticRegistrationRequest();
    const json = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
    expect(json.localAddress).toBe('192.0.2.10');
    expect(json.usesProxy).toBe(true);
    expect(json.usesTLS).toBeUndefined();
    expect(json.systemFolderCreationTicks).toBe('638000000000000000');
    const decoded = json as unknown as RegistrationRequest;
    expect(registrationBytes(decoded)).toEqual(registrationBytes(request));
    // Swift validates the address at decode time; here it is validated when the text is built.
    expectError(
      () => registrationText({ ...request, localAddress: '999.0.0.1' }), RelayIPv4AddressError, 'invalidAddress');
  });

  test('localAddress is serialized in canonical dotted form (RelayIPv4Address.description)', () => {
    const request = { ...syntheticRegistrationRequest(), localAddress: '192.168.001.010' };
    expect(registrationText(request).split(':')[4]).toBe('192.168.1.10');
  });
});

describe('registration reply (ClientRegistrationTests.swift)', () => {
  test('registrationReplyPreservesOpaqueAndConditionalFields', () => {
    const text = '3:443:00111222333:203.0.113.7:unknown:1:ping-list:0:17/10/2026:relay.example:opaque-token:future:';
    const reply = parseRegistrationReply(enc(text));
    expect(reply.publicPort).toBe(443);
    expect(reply.assignedID).toBe(111222333n);
    expect(reply.assignedIDText).toBe('111222333');
    expect(reply.fields[2]).toBe('00111222333');
    expect(reply.publicAddress).toBe('203.0.113.7');
    expect(reply.requestsOldVersionWarning).toBe(true);
    expect(reply.pingList).toBe('ping-list');
    expect(reply.pingHostNameList).toBe('relay.example');
    expect(reply.statusDateText).toBe('17/10/2026');
    expect(reply.opaqueServerToken).toBe('opaque-token');
    expect(reply.fields.slice(-2)).toEqual(['future', '']);

    // Field 8 is ignored by the desktop when field 7 is -1. All 11 positions
    // still exist because the receiver consumes field 10 unconditionally.
    const noDate = parseRegistrationReply(enc('3:2112:42:192.0.2.2::0::-1:ignored::'));
    expect(noDate.statusDateText).toBeNull();
    expect(noDate.fields[8]).toBe('ignored');
    expect(noDate.pingHostNameList).toBe('');
    expect(noDate.opaqueServerToken).toBe('');
  });

  test('registrationReplyRejectsMalformedIdentityEndpointAndBudgets', () => {
    const valid = ['3', '443', '123456789', '203.0.113.10', '', '0', '', '-1', '', '', ''];
    const cases: [number, string, string][] = [
      [0, '8', 'invalidCommand'],
      [1, '0', 'invalidPort'], [1, '65536', 'invalidPort'], [1, '-1', 'invalidPort'],
      [2, '0', 'invalidID'], [2, '18446744073709551616', 'invalidID'], [2, '1e5', 'invalidID'],
      [3, '256.0.0.1', 'invalidAddress'], [3, 'localhost', 'invalidAddress'],
      [7, '2147483648', 'invalidStatus'], [7, '', 'invalidStatus'],
    ];
    for (const [index, value, code] of cases) {
      const fields = [...valid];
      fields[index] = value;
      expectRegistrationError(() => parseRegistrationReply(enc(fields.join(':'))), code);
    }
    const bytes = enc(valid.join(':'));
    expectRegistrationError(
      () => parseRegistrationReply(bytes, { maximumPayloadBytes: bytes.length - 1 }), 'payloadTooLarge');
    expectRegistrationError(() => parseRegistrationReply(bytes, { maximumFieldCount: 10 }), 'tooManyFields');
    expectRegistrationError(() => parseRegistrationReply(enc('3:443:123:192.0.2.1')), 'missingFields');
    const withNul = new Uint8Array(bytes.length + 1);
    withNul.set(bytes);
    expectRegistrationError(() => parseRegistrationReply(withNul), 'unsupportedEncoding');
  });

  test('max uint64 id is accepted exactly, status text must round-trip', () => {
    const base = (id: string, status: string) => enc(`3:443:${id}:203.0.113.10::0::${status}::::`);
    expect(parseRegistrationReply(base('18446744073709551615', '-1')).assignedIDText).toBe('18446744073709551615');
    expectRegistrationError(() => parseRegistrationReply(base('5', '+1')), 'invalidStatus');
    expectRegistrationError(() => parseRegistrationReply(base('5', '-0')), 'invalidStatus');
    expectRegistrationError(() => parseRegistrationReply(base('5', '01')), 'invalidStatus');
    expect(parseRegistrationReply(base('5', '-2147483648')).status).toBe(-2147483648);
  });
});
