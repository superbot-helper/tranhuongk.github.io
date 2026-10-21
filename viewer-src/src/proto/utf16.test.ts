import { describe, expect, test } from 'vitest';
import { decodeUtf16leStrict, toWellFormed, utf16le, utf8Length } from './utf16';
import { u8 } from './test-utils';

describe('utf16 helpers', () => {
  test('utf16le encodes code units little-endian', () => {
    expect(utf16le('Aế🙂')).toEqual(u8(0x41, 0, 0xbf, 0x1e, 0x3d, 0xd8, 0x42, 0xde));
    expect(utf16le('')).toEqual(new Uint8Array());
  });

  test('toWellFormed replaces only lone surrogates', () => {
    expect(toWellFormed('a🙂b')).toBe('a🙂b');
    expect(toWellFormed('\ud800')).toBe('�');
    expect(toWellFormed('\udc00x')).toBe('�x');
    expect(toWellFormed('\ud800𐀀')).toBe('�𐀀');
  });

  test('utf8Length counts bytes', () => {
    expect(utf8Length('a')).toBe(1);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('日')).toBe(3);
    expect(utf8Length('🙂')).toBe(4);
  });

  test('decodeUtf16leStrict accepts pairs and a leading BOM, rejects the rest', () => {
    expect(decodeUtf16leStrict(u8(0x41, 0, 0x3d, 0xd8, 0x42, 0xde))).toBe('A🙂');
    expect(decodeUtf16leStrict(u8(0xff, 0xfe))).toBe('﻿'); // BOM is data, not stripped.
    expect(decodeUtf16leStrict(new Uint8Array())).toBe('');
    for (const bad of [u8(0x41), u8(0, 0xd8), u8(0, 0xdc), u8(0, 0xd8, 0x41, 0)]) {
      expect(decodeUtf16leStrict(bad)).toBeNull();
    }
  });

  test('large inputs decode without stack overflow', () => {
    const bytes = new Uint8Array(1024 * 1024).fill(0x41);
    bytes.forEach((_, i) => {
      if (i % 2) bytes[i] = 0;
    });
    expect(decodeUtf16leStrict(bytes)?.length).toBe(524_288);
  });
});
