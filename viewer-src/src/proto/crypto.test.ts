import { describe, expect, test } from 'vitest';
import { LegacyCommandCipher, LegacyCommandCipherError, commandCipher, md5Hex } from './crypto';
import { enc, expectError } from './test-utils';

function hex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error('odd hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Ported from LegacyCommandCipherTests.swift (vectors unchanged).
describe('LegacyCommandCipher (LegacyCommandCipherTests.swift)', () => {
  test('commandCipherMatchesIndependentOpenSSLVector', () => {
    // Independently generated with OpenSSL des-ede3-cbc; SHA1(UTF16LE password)
    // + four zero bytes: 5fe6ab3e8a13661e974f52628ee46616d868286300000000.
    // IV: da39a3ee5e6b4b0d. Password includes a non-ASCII UTF-16 code unit.
    const cipher = new LegacyCommandCipher('fixture-⌘');
    const plaintext = enc('8:123456789:synthetic-proof');
    const expected = hex('b63b9797064974fa31181fef729c755558492379dcb44c69e3fe4c6d0e29836c');
    expect(cipher.encrypt(plaintext)).toEqual(expected);
    expect(cipher.decrypt(expected)).toEqual(plaintext);
  });

  test('configuredDesktopServerCipherMatchesStaticKeyFixture', () => {
    // Independent OpenSSL fixture from the key/IV recovered at native 0x635a8c.
    const encrypted = hex('c842551785856d0b8f866afed8dcd8b1');
    expect(commandCipher.encrypt(enc('8:fixture'))).toEqual(encrypted);
    expect(commandCipher.decrypt(encrypted)).toEqual(enc('8:fixture'));
  });

  test('commandCipherRoundTripsBlockBoundariesAndUnicodePasswords', () => {
    for (const password of ['', 'compatibility-test', '\u{1F511}é⌘']) {
      const cipher = new LegacyCommandCipher(password);
      for (const length of [0, 1, 7, 8, 9, 15, 16, 17, 1024]) {
        const plaintext = Uint8Array.from({ length }, (_, i) => i & 0xff);
        const encrypted = cipher.encrypt(plaintext);
        expect(encrypted.length).toBeGreaterThan(0);
        expect(encrypted.length).toBe((Math.floor(length / 8) + 1) * 8);
        expect(cipher.decrypt(encrypted)).toEqual(plaintext);
      }
    }
  });

  test('commandCipherRejectsMalformedAndInvalidPadding', () => {
    const cipher = new LegacyCommandCipher('fixture-⌘');
    for (const invalid of [new Uint8Array(), new Uint8Array([1]), new Uint8Array(7), new Uint8Array(9)]) {
      expectError(() => cipher.decrypt(invalid), LegacyCommandCipherError, 'malformedCiphertext');
    }
    // OpenSSL -nopad fixtures decrypt to 3132333435360203 (mismatched bytes),
    // 3132333435363700 (zero padding), 3132333435363709 (oversized padding).
    for (const invalid of ['e074f13ae60ec9e4', '22959c7b190b62a7', 'da71e6936b3c4dba']) {
      expectError(() => cipher.decrypt(hex(invalid)), LegacyCommandCipherError, 'invalidPadding');
    }
  });
});

describe('md5Hex', () => {
  test('RFC 1321 vectors, lowercase by default (Swift String(format: "%02x"))', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
  });

  test('uppercase option (Swift String(format: "%02X"))', () => {
    expect(md5Hex('abc', { upper: true })).toBe('900150983CD24FB0D6963F7D28E17F72');
    expect(md5Hex('abc', { upper: false })).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  test('hashes the UTF-8 bytes of the input', () => {
    // MD5("é") over UTF-8 bytes c3 a9; Python: hashlib.md5("é".encode()).hexdigest()
    expect(md5Hex('é')).toBe('66ddcd97cfdeabb2f6fb8a999b4bc76f');
  });
});
