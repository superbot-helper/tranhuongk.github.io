import { createHash, createCipheriv } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  PreambleDecoder,
  RelayEnvelopeError,
  RelayHTTPPreambleDecoderError,
  RelayHTTPPreambleError,
  RelayIPv4AddressError,
  decodeEnvelope,
  encodeEnvelope,
  encodeSystem,
  httpPreamble,
  keepaliveCommandEnvelope,
  keepaliveRelayEnvelope,
  parseIPv4,
  type RelayEnvelope,
} from './envelope';
import { encodeFrame } from './frame';
import { concat, enc, expectError, rep, u8 } from './test-utils';

// Ported from RelayEnvelopeTests.swift (DirectPeerEnvelope intentionally not ported: no LAN direct).
describe('envelope (RelayEnvelopeTests.swift)', () => {
  test('distinctRelayHeartbeatsMatchIndependentWireFixtures', () => {
    expect(encodeFrame(keepaliveRelayEnvelope())).toEqual(u8(5, 0, 0, 0, 1, 0x70, 0x69, 0x6e, 0x67));
    expect(encodeFrame(keepaliveCommandEnvelope())).toEqual(
      u8(10, 0, 0, 0, 1, 0, 0x2d, 0x93, 0x29, 0x71, 0xdd, 0x9d, 0xcb, 0x2d),
    );
  });

  test('keepalive command ciphertext matches a fresh derivation of the legacy 3DES cipher', () => {
    // key = SHA1(UTF-16LE(chars 5,10,15,20,25)) zero-extended to 24 bytes; iv = SHA1("")[0..8]; CBC + PKCS7.
    const password = String.fromCharCode(5, 10, 15, 20, 25);
    const key = Buffer.concat([createHash('sha1').update(Buffer.from(password, 'utf16le')).digest(), Buffer.alloc(4)]);
    const iv = createHash('sha1').update('').digest().subarray(0, 8);
    const c = createCipheriv('des-ede3-cbc', key, iv);
    const cipher = Buffer.concat([c.update('2'), c.final()]);
    expect(new Uint8Array(keepaliveCommandEnvelope())).toEqual(new Uint8Array(concat(u8(1, 0), cipher)));
  });

  test('relayRoutingByteOrderAndRoundTrip', () => {
    const envelope: RelayEnvelope = {
      kind: 'forward', address: '192.0.2.10', port: 12345, formatFlag: false, payload: u8(0xaa, 0xbb),
    };
    const inner = u8(0, 0, 10, 2, 0, 192, 0x39, 0x30, 0xaa, 0xbb);
    expect(encodeEnvelope(envelope)).toEqual(inner);
    expect(decodeEnvelope(inner)).toEqual(envelope);
    expect(encodeFrame(inner)).toEqual(concat(u8(10, 0, 0, 0), inner));
    const noncanonical = decodeEnvelope(encodeEnvelope({ ...envelope, address: '192.000.2.10' }));
    expect(noncanonical).toMatchObject({ address: '192.0.2.10' });
    const maximumPort: RelayEnvelope = {
      kind: 'forward', address: '255.255.255.255', port: 0xffff, formatFlag: true, payload: new Uint8Array(),
    };
    expect(encodeEnvelope(maximumPort)).toEqual(u8(0, 1, 255, 255, 255, 255, 255, 255));
    expect(decodeEnvelope(encodeEnvelope(maximumPort))).toEqual(maximumPort);
  });

  test('relayMalformedAndNoncanonicalFlag', () => {
    expectError(() => decodeEnvelope(new Uint8Array()), RelayEnvelopeError, 'emptyEnvelope');
    for (let count = 1; count < 8; count++) {
      expectError(() => decodeEnvelope(new Uint8Array(count)), RelayEnvelopeError, 'truncatedForward');
    }
    expectError(() => decodeEnvelope(u8(2)), RelayEnvelopeError, 'unknownKind');
    try {
      decodeEnvelope(u8(2));
    } catch (e) {
      expect((e as RelayEnvelopeError).kind).toBe(2);
    }
    expect(decodeEnvelope(u8(0, 255, 10, 2, 0, 192, 0, 0))).toEqual({
      kind: 'forward', address: '192.0.2.10', port: 0, formatFlag: true, payload: new Uint8Array(),
    });
    for (const invalid of ['', '1.2.3', '1.2.3.4.5', '1..3.4', '256.2.3.4', '-1.2.3.4',
      '1.2.3. 4', '1.2.3.4\n', '１.2.3.4', '0000.2.3.4']) {
      expectError(() => parseIPv4(invalid), RelayIPv4AddressError, 'invalidAddress');
    }
    expect(parseIPv4('192.0.2.10')).toEqual(u8(192, 0, 2, 10));
  });

  test('systemAndDirectEnvelopesHaveDifferentHeaders', () => {
    const payload = u8(0x31, 0x7c, 0x7c, 0x7c);
    expect(encodeEnvelope({ kind: 'system', formatFlag: null, payload })).toEqual(concat(u8(1), payload));
    expect(encodeSystem(payload)).toEqual(concat(u8(1), payload));
    expect(encodeSystem(payload, false)).toEqual(concat(u8(1, 0), payload));
    expect(encodeSystem(payload, true)).toEqual(concat(u8(1, 1), payload));
    // The receiver leaves a system command's optional flag for its application parser.
    expect(decodeEnvelope(concat(u8(1, 1), payload))).toEqual({
      kind: 'system', formatFlag: null, payload: concat(u8(1), payload),
    });
    expect(decodeEnvelope(u8(1))).toEqual({ kind: 'system', formatFlag: null, payload: new Uint8Array() });
    // Sub-array input must not rely on a zero byteOffset.
    const sliced = concat(u8(99), concat(u8(1, 1), payload)).subarray(1);
    expect(decodeEnvelope(sliced)).toEqual({ kind: 'system', formatFlag: null, payload: concat(u8(1), payload) });
  });

  test('recoveredStreamingHTTPRequest', () => {
    const expected = 'POST /UVService/ HTTP/1.1\r\n' +
      'User-Agent: Mozilla/4.0 (compatible; MSIE5.01; Windows NT)\r\n' +
      'Content-Type: application/octet-stream\r\n' +
      'Connection: Keep-Alive\r\nContent-length: 8589934590\r\n' +
      'Host: example.invalid:443\r\n\r\n';
    expect(httpPreamble('example.invalid:443')).toEqual(enc(expected));
    expect(httpPreamble('example.invalid', 'GET').slice(0, 26)).toEqual(enc('GET /UVService/ HTTP/1.1\r\n'));
    for (const invalid of ['', 'a\r\nX: injected', 'a b', 'a\t', 'a\u007f', 'é.example']) {
      expectError(() => httpPreamble(invalid), RelayHTTPPreambleError, 'invalidHost');
    }
  });

  test('responseHeaderFragmentationAndBinaryCoalescing', () => {
    const header = enc('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n');
    const body = u8(3, 0, 0, 0, 1, 2, 3, 13, 10, 13, 10);
    const wire = concat(header, body);
    for (let split = 0; split <= wire.length; split++) {
      const decoder = new PreambleDecoder(header.length);
      const result = concat(decoder.push(wire.slice(0, split)), decoder.push(wire.slice(split)));
      expect(result).toEqual(body);
      expect(decoder.hasReceivedHeader).toBe(true);
      expect(decoder.responseStatusCode).toBe(200);
      expect(decoder.push(u8(42))).toEqual(u8(42));
    }
    const decoder = new PreambleDecoder();
    const parts: Uint8Array[] = [];
    for (const byte of wire) parts.push(decoder.push(u8(byte)));
    expect(concat(...parts)).toEqual(body);
    decoder.reset();
    expect(decoder.hasReceivedHeader).toBe(false);
    expect(decoder.responseStatusCode).toBeNull();
    expect(decoder.push(u8(13, 10, 13, 10, 0))).toEqual(u8(0));
    expect(decoder.responseStatusCode).toBeNull();
    decoder.reset();
    expect(decoder.push(enc('HTTP/1.1 403 Forbidden\r\n\r\n'))).toEqual(new Uint8Array());
    expect(decoder.responseStatusCode).toBe(403);
  });

  test('responseHeaderBudgetDoesNotCountBody', () => {
    const decoder = new PreambleDecoder(4);
    const body = rep(42, 100_000);
    expect(decoder.push(concat(u8(13, 10, 13, 10), body))).toEqual(body);
    const bad = new PreambleDecoder(4);
    expect(bad.push(u8(1, 2, 3, 4))).toEqual(new Uint8Array());
    expectError(() => bad.push(u8(5)), RelayHTTPPreambleDecoderError, 'headerTooLarge');
    expect(bad.hasReceivedHeader).toBe(false);
  });
});

// Review Focus 3 (task brief).
describe('preamble decoder, arbitrary TCP chunking', () => {
  test('preamble decoder returns body bytes even if CRLFCRLF is split', () => {
    const d = new PreambleDecoder();
    expect(d.push(enc('HTTP/1.1 200 OK\r\nX: y\r'))).toEqual(new Uint8Array());
    expect(d.push(enc('\n\r\nABC'))).toEqual(enc('ABC'));
    expect(d.push(enc('D'))).toEqual(enc('D'));
  });
});
