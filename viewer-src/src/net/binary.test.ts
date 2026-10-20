import { expect, test } from 'vitest';
import { binaryToBytes, bytesToBinary } from './binary';

test('bytesToBinary / binaryToBytes round-trip 1 MiB (one big WebSocket message) without a stack overflow', () => {
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 7 + (i >> 8)) & 0xff);
  const s = bytesToBinary(bytes);
  expect(s.length).toBe(bytes.length);
  expect(s.charCodeAt(0)).toBe(bytes[0]);
  expect(s.charCodeAt(bytes.length - 1)).toBe(bytes[bytes.length - 1]);
  expect(binaryToBytes(s)).toEqual(bytes);
});

test('handles empty input, slice boundaries and every byte value', () => {
  expect(bytesToBinary(new Uint8Array(0))).toBe('');
  expect(binaryToBytes('')).toEqual(new Uint8Array(0));
  for (const n of [1, 8191, 8192, 8193, 16384]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => i & 0xff);
    expect(binaryToBytes(bytesToBinary(bytes))).toEqual(bytes);
  }
  // A subarray view must encode only its own window.
  const view = Uint8Array.from([9, 1, 2, 3, 9]).subarray(1, 4);
  expect(bytesToBinary(view)).toBe('\x01\x02\x03');
});
