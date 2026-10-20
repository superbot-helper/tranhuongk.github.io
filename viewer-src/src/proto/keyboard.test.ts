import { describe, expect, test } from 'vitest';
import { KeyboardMessageError, keyboardKindFromWindowsMessage, keyboardPacket } from './keyboard';
import { u8 } from './test-utils';

// Ported from KeyboardMessageTests.swift.
describe('keyboard message (KeyboardMessageTests.swift)', () => {
  test('keyboardPayloadMatchesRecoveredByteLayout', () => {
    // Independent byte fixture: command30, separator "|||", compact key-down1, VK_A65,
    // scan0x001e, UTF-16 code unit0x0041, Boolean false0.
    const key = keyboardPacket({
      kind: keyboardKindFromWindowsMessage(0x100),
      vk: 0x41,
      scan: 0x001e,
      character: 0x0041,
      capsLock: false,
    });
    expect(key).toEqual(u8(0x1e, 0x7c, 0x7c, 0x7c, 0x01, 0x41, 0x1e, 0x00, 0x41, 0x00, 0x00));
    // Both UInt16 fields must preserve their high bytes. Raw concatenation, no length prefixes.
    const system = keyboardPacket({ kind: 4, vk: 0xa5, scan: 0x1234, character: 0x20ac, capsLock: true });
    expect(system).toEqual(u8(0x1e, 0x7c, 0x7c, 0x7c, 0x04, 0xa5, 0x34, 0x12, 0xac, 0x20, 0x01));
    expect(system).toHaveLength(11);
  });

  test('compactKeyboardKindsAreDistinctFromWindowMessages', () => {
    const mapping: [number, 1 | 2 | 3 | 4][] = [
      [0x100, 1],
      [0x101, 2],
      [0x104, 3],
      [0x105, 4],
    ];
    for (const [windowsMessage, compact] of mapping) {
      expect(keyboardKindFromWindowsMessage(windowsMessage)).toBe(compact);
    }
    for (const unsupported of [0, 1, 2, 3, 4, 0x102, 0x103, 0x200, 0xffffffff]) {
      let thrown: unknown;
      try {
        keyboardKindFromWindowsMessage(unsupported);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(KeyboardMessageError);
      expect(thrown).toMatchObject({ code: 'unsupportedWindowsMessage', windowsMessage: unsupported });
    }
  });

  test('keyboardPayloadSupportsZeroAndFullWidthValues', () => {
    expect(keyboardPacket({ kind: 2, vk: 0, scan: 0, character: 0, capsLock: false })).toEqual(
      u8(30, 124, 124, 124, 2, 0, 0, 0, 0, 0, 0),
    );
    expect(keyboardPacket({ kind: 3, vk: 255, scan: 65535, character: 65535, capsLock: true })).toEqual(
      u8(30, 124, 124, 124, 3, 255, 255, 255, 255, 255, 1),
    );
  });

  // TypeScript-only: Swift's UInt8/UInt16 field types become runtime range checks.
  test('rejects fields outside the fixed-width ranges', () => {
    const base = { kind: 1 as const, vk: 0, scan: 0, character: 0, capsLock: false };
    expect(() => keyboardPacket({ ...base, vk: 256 })).toThrow(RangeError);
    expect(() => keyboardPacket({ ...base, vk: -1 })).toThrow(RangeError);
    expect(() => keyboardPacket({ ...base, scan: 65536 })).toThrow(RangeError);
    expect(() => keyboardPacket({ ...base, character: 0.5 })).toThrow(RangeError);
    expect(() => keyboardPacket({ ...base, kind: 5 as 1 })).toThrow(RangeError);
  });
});
