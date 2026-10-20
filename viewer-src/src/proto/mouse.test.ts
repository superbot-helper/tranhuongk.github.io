import { describe, expect, test } from 'vitest';
import {
  MOUSE_BUTTON_MESSAGES,
  MouseButtonMessage,
  isMouseButtonMessage,
  mouseButtonText,
  mouseMoveText,
  mouseWheelText,
  packedPosition,
  wheelWParam,
} from './mouse';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

// Ported from MouseMessageTests.swift.
describe('mouse messages (MouseMessageTests.swift)', () => {
  test('mouseMoveAndButtonHaveDifferentParameterShapes', () => {
    const move = mouseMoveText(1, -1920, 1080);
    expect(move).toBe('8|||512|||1|||-1920|||1080');
    const down = mouseButtonText(MouseButtonMessage.LeftDown, 1, 0x0028001e);
    expect(down).toBe('8|||513|||1|||2621470');
    expect(down.split('|||')).toHaveLength(4);
    expect(move.split('|||')).toHaveLength(5);
    expect(down.endsWith('|||')).toBe(false);
  });

  test('mouseButtonMappingMatchesObservedWindowMessageRange', () => {
    expect([...MOUSE_BUTTON_MESSAGES]).toEqual([0x201, 0x202, 0x203, 0x204, 0x205, 0x206, 0x207, 0x208, 0x209]);
    expect(MouseButtonMessage.LeftDown).toBe(0x201);
    expect(MouseButtonMessage.LeftUp).toBe(0x202);
    expect(MouseButtonMessage.RightDown).toBe(0x204);
    expect(MouseButtonMessage.RightUp).toBe(0x205);
    expect(MouseButtonMessage.MiddleDown).toBe(0x207);
    expect(MouseButtonMessage.MiddleUp).toBe(0x208);
    for (const button of MOUSE_BUTTON_MESSAGES) {
      expect(mouseButtonText(button, 0, -1)).toBe(`8|||${button}|||0|||-1`);
    }
    expect(isMouseButtonMessage(0x200)).toBe(false);
    expect(isMouseButtonMessage(0x20a)).toBe(false);
    expect(isMouseButtonMessage(0x20b)).toBe(false);
    expect(isMouseButtonMessage(0x201)).toBe(true);
    expect(isMouseButtonMessage(0x209)).toBe(true);
    expect(() => mouseButtonText(0x20a as MouseButtonMessage, 0, 0)).toThrow(RangeError);
  });

  test('wheelPreservesPackedSignedWParamAndPosition', () => {
    // Independently calculated Win32 words: (-120 & 0xffff) << 16 | 8
    // = 0xff880008 = signed -7864312. Position (-10,-20) is 0xffecfff6.
    const wParam = wheelWParam(-120, 8);
    const lParam = packedPosition(-10, -20);
    expect(wParam).toBe(-7_864_312);
    expect(lParam).toBe(-1_245_194);
    expect(mouseWheelText(wParam, lParam)).toBe('8|||522|||-7864312|||-1245194');
    expect(wheelWParam(120, 0)).toBe(7_864_320);
    expect(packedPosition(30, 40)).toBe(2_621_470);
  });

  test('mouseFieldsUseSignedLongDecimalWithoutTruncation', () => {
    expect(mouseMoveText(INT32_MIN, INT32_MAX, INT32_MIN)).toBe('8|||512|||-2147483648|||2147483647|||-2147483648');
    expect(wheelWParam(-32768, 0)).toBe(INT32_MIN);
    expect(wheelWParam(-1, 0xffff)).toBe(-1);
    expect(packedPosition(-1, -1)).toBe(-1);
  });

  // TypeScript-only: Swift's Int32/Int16 parameter types become runtime range checks.
  test('rejects values the fixed-width Swift types could not hold', () => {
    expect(() => mouseMoveText(0, 2 ** 31, 0)).toThrow(RangeError);
    expect(() => mouseMoveText(0, 1.5, 0)).toThrow(RangeError);
    expect(() => mouseMoveText(Number.NaN, 0, 0)).toThrow(RangeError);
    expect(() => mouseButtonText(MouseButtonMessage.LeftUp, 0, -(2 ** 31) - 1)).toThrow(RangeError);
    expect(() => mouseWheelText(2 ** 31, 0)).toThrow(RangeError);
    expect(() => packedPosition(32768, 0)).toThrow(RangeError);
    expect(() => packedPosition(0, -32769)).toThrow(RangeError);
    expect(() => wheelWParam(32768, 0)).toThrow(RangeError);
    expect(() => wheelWParam(0, 0x10000)).toThrow(RangeError);
    expect(() => wheelWParam(0, -1)).toThrow(RangeError);
  });
});
