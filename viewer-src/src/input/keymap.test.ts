import { describe, expect, test } from 'vitest';
import { codeToKey, codeToKeyInfo } from './keymap';

// Every row of Swift MacRemoteInputEncoder.mapping (M:272-382), generated from the Swift source:
// [browser code, Windows VK, scan]. The kVK position is in the trailing comment.
const SWIFT_TABLE: [string, number, number][] = [
  ['AltLeft', 0xa4, 0x38], // kVK 0x3a Option
  ['AltRight', 0xa5, 0xe038], // kVK 0x3d RightOption
  ['ArrowDown', 0x28, 0xe050], // kVK 0x7d DownArrow
  ['ArrowLeft', 0x25, 0xe04b], // kVK 0x7b LeftArrow
  ['ArrowRight', 0x27, 0xe04d], // kVK 0x7c RightArrow
  ['ArrowUp', 0x26, 0xe048], // kVK 0x7e UpArrow
  ['Backquote', 0xc0, 0x29], // kVK 0x32 ANSI_Grave
  ['Backslash', 0xdc, 0x2b], // kVK 0x2a ANSI_Backslash
  ['Backspace', 0x08, 0x0e], // kVK 0x33 Delete
  ['BracketLeft', 0xdb, 0x1a], // kVK 0x21 ANSI_LeftBracket
  ['BracketRight', 0xdd, 0x1b], // kVK 0x1e ANSI_RightBracket
  ['Comma', 0xbc, 0x33], // kVK 0x2b ANSI_Comma
  ['ContextMenu', 0x5d, 0xe05d], // kVK 0x6e ContextualMenu
  ['ControlLeft', 0xa2, 0x1d], // kVK 0x3b Control
  ['ControlRight', 0xa3, 0xe01d], // kVK 0x3e RightControl
  ['Delete', 0x2e, 0xe053], // kVK 0x75 ForwardDelete
  ['Digit0', 0x30, 0x0b], // kVK 0x1d ANSI_0
  ['Digit1', 0x31, 0x02], // kVK 0x12 ANSI_1
  ['Digit2', 0x32, 0x03], // kVK 0x13 ANSI_2
  ['Digit3', 0x33, 0x04], // kVK 0x14 ANSI_3
  ['Digit4', 0x34, 0x05], // kVK 0x15 ANSI_4
  ['Digit5', 0x35, 0x06], // kVK 0x17 ANSI_5
  ['Digit6', 0x36, 0x07], // kVK 0x16 ANSI_6
  ['Digit7', 0x37, 0x08], // kVK 0x1a ANSI_7
  ['Digit8', 0x38, 0x09], // kVK 0x1c ANSI_8
  ['Digit9', 0x39, 0x0a], // kVK 0x19 ANSI_9
  ['End', 0x23, 0xe04f], // kVK 0x77 End
  ['Enter', 0x0d, 0x1c], // kVK 0x24 Return
  ['Equal', 0xbb, 0x0d], // kVK 0x18 ANSI_Equal
  ['Escape', 0x1b, 0x01], // kVK 0x35 Escape
  ['F1', 0x70, 0x3b], // kVK 0x7a F1
  ['F10', 0x79, 0x44], // kVK 0x6d F10
  ['F11', 0x7a, 0x57], // kVK 0x67 F11
  ['F12', 0x7b, 0x58], // kVK 0x6f F12
  ['F13', 0x7c, 0x64], // kVK 0x69 F13
  ['F14', 0x7d, 0x65], // kVK 0x6b F14
  ['F15', 0x7e, 0x66], // kVK 0x71 F15
  ['F16', 0x7f, 0x67], // kVK 0x6a F16
  ['F17', 0x80, 0x68], // kVK 0x40 F17
  ['F18', 0x81, 0x69], // kVK 0x4f F18
  ['F19', 0x82, 0x6a], // kVK 0x50 F19
  ['F2', 0x71, 0x3c], // kVK 0x78 F2
  ['F20', 0x83, 0x6b], // kVK 0x5a F20
  ['F3', 0x72, 0x3d], // kVK 0x63 F3
  ['F4', 0x73, 0x3e], // kVK 0x76 F4
  ['F5', 0x74, 0x3f], // kVK 0x60 F5
  ['F6', 0x75, 0x40], // kVK 0x61 F6
  ['F7', 0x76, 0x41], // kVK 0x62 F7
  ['F8', 0x77, 0x42], // kVK 0x64 F8
  ['F9', 0x78, 0x43], // kVK 0x65 F9
  ['Home', 0x24, 0xe047], // kVK 0x73 Home
  ['Insert', 0x2d, 0xe052], // kVK 0x72 Help
  ['KeyA', 0x41, 0x1e], // kVK 0x00 ANSI_A
  ['KeyB', 0x42, 0x30], // kVK 0x0b ANSI_B
  ['KeyC', 0x43, 0x2e], // kVK 0x08 ANSI_C
  ['KeyD', 0x44, 0x20], // kVK 0x02 ANSI_D
  ['KeyE', 0x45, 0x12], // kVK 0x0e ANSI_E
  ['KeyF', 0x46, 0x21], // kVK 0x03 ANSI_F
  ['KeyG', 0x47, 0x22], // kVK 0x05 ANSI_G
  ['KeyH', 0x48, 0x23], // kVK 0x04 ANSI_H
  ['KeyI', 0x49, 0x17], // kVK 0x22 ANSI_I
  ['KeyJ', 0x4a, 0x24], // kVK 0x26 ANSI_J
  ['KeyK', 0x4b, 0x25], // kVK 0x28 ANSI_K
  ['KeyL', 0x4c, 0x26], // kVK 0x25 ANSI_L
  ['KeyM', 0x4d, 0x32], // kVK 0x2e ANSI_M
  ['KeyN', 0x4e, 0x31], // kVK 0x2d ANSI_N
  ['KeyO', 0x4f, 0x18], // kVK 0x1f ANSI_O
  ['KeyP', 0x50, 0x19], // kVK 0x23 ANSI_P
  ['KeyQ', 0x51, 0x10], // kVK 0x0c ANSI_Q
  ['KeyR', 0x52, 0x13], // kVK 0x0f ANSI_R
  ['KeyS', 0x53, 0x1f], // kVK 0x01 ANSI_S
  ['KeyT', 0x54, 0x14], // kVK 0x11 ANSI_T
  ['KeyU', 0x55, 0x16], // kVK 0x20 ANSI_U
  ['KeyV', 0x56, 0x2f], // kVK 0x09 ANSI_V
  ['KeyW', 0x57, 0x11], // kVK 0x0d ANSI_W
  ['KeyX', 0x58, 0x2d], // kVK 0x07 ANSI_X
  ['KeyY', 0x59, 0x15], // kVK 0x10 ANSI_Y
  ['KeyZ', 0x5a, 0x2c], // kVK 0x06 ANSI_Z
  ['MetaLeft', 0x5b, 0xe05b], // kVK 0x37 Command
  ['MetaRight', 0x5c, 0xe05c], // kVK 0x36 RightCommand
  ['Minus', 0xbd, 0x0c], // kVK 0x1b ANSI_Minus
  ['NumLock', 0x0c, 0x4c], // kVK 0x47 ANSI_KeypadClear
  ['Numpad0', 0x60, 0x52], // kVK 0x52 ANSI_Keypad0
  ['Numpad1', 0x61, 0x4f], // kVK 0x53 ANSI_Keypad1
  ['Numpad2', 0x62, 0x50], // kVK 0x54 ANSI_Keypad2
  ['Numpad3', 0x63, 0x51], // kVK 0x55 ANSI_Keypad3
  ['Numpad4', 0x64, 0x4b], // kVK 0x56 ANSI_Keypad4
  ['Numpad5', 0x65, 0x4c], // kVK 0x57 ANSI_Keypad5
  ['Numpad6', 0x66, 0x4d], // kVK 0x58 ANSI_Keypad6
  ['Numpad7', 0x67, 0x47], // kVK 0x59 ANSI_Keypad7
  ['Numpad8', 0x68, 0x48], // kVK 0x5b ANSI_Keypad8
  ['Numpad9', 0x69, 0x49], // kVK 0x5c ANSI_Keypad9
  ['NumpadAdd', 0x6b, 0x4e], // kVK 0x45 ANSI_KeypadPlus
  ['NumpadDecimal', 0x6e, 0x53], // kVK 0x41 ANSI_KeypadDecimal
  ['NumpadDivide', 0x6f, 0xe035], // kVK 0x4b ANSI_KeypadDivide
  ['NumpadEnter', 0x0d, 0xe01c], // kVK 0x4c ANSI_KeypadEnter
  ['NumpadEqual', 0xbb, 0x59], // kVK 0x51 ANSI_KeypadEquals
  ['NumpadMultiply', 0x6a, 0x37], // kVK 0x43 ANSI_KeypadMultiply
  ['NumpadSubtract', 0x6d, 0x4a], // kVK 0x4e ANSI_KeypadMinus
  ['PageDown', 0x22, 0xe051], // kVK 0x79 PageDown
  ['PageUp', 0x21, 0xe049], // kVK 0x74 PageUp
  ['Period', 0xbe, 0x34], // kVK 0x2f ANSI_Period
  ['Quote', 0xde, 0x28], // kVK 0x27 ANSI_Quote
  ['Semicolon', 0xba, 0x27], // kVK 0x29 ANSI_Semicolon
  ['ShiftLeft', 0xa0, 0x2a], // kVK 0x38 Shift
  ['ShiftRight', 0xa1, 0x36], // kVK 0x3c RightShift
  ['Slash', 0xbf, 0x35], // kVK 0x2c ANSI_Slash
  ['Space', 0x20, 0x39], // kVK 0x31 Space
  ['Tab', 0x09, 0x0f], // kVK 0x30 Tab
];

describe('keymap (MacRemoteInputEncoder.mapping)', () => {
  test('covers all 109 Swift physical keys with identical VK and scan', () => {
    expect(SWIFT_TABLE).toHaveLength(109);
    expect(new Set(SWIFT_TABLE.map(([code]) => code)).size).toBe(109);
    for (const [code, vk, scan] of SWIFT_TABLE) {
      expect(codeToKey(code), code).toEqual({ vk, scan });
    }
  });

  test('brief examples', () => {
    expect(codeToKey('KeyA')).toEqual({ vk: 0x41, scan: 0x1e });
    expect(codeToKey('ArrowLeft')).toEqual({ vk: 0x25, scan: 0xe04b });
    expect(codeToKey('MetaLeft')).toEqual({ vk: 0x5b, scan: 0xe05b });
    expect(codeToKey('AltRight')).toEqual({ vk: 0xa5, scan: 0xe038 });
    expect(codeToKey('NumpadEnter')).toEqual({ vk: 0x0d, scan: 0xe01c });
  });

  test('PC-only and extended positions beyond the Swift set', () => {
    expect(codeToKey('Help')).toEqual(codeToKey('Insert'));
    expect(codeToKey('Insert')).toEqual({ vk: 0x2d, scan: 0xe052 });
    expect(codeToKey('IntlBackslash')).toEqual({ vk: 0xe2, scan: 0x56 });
    expect(codeToKey('CapsLock')).toEqual({ vk: 0x14, scan: 0x3a });
    expect(codeToKey('PrintScreen')).toEqual({ vk: 0x2c, scan: 0xe037 });
    expect(codeToKey('ScrollLock')).toEqual({ vk: 0x91, scan: 0x46 });
    expect(codeToKey('Pause')).toEqual({ vk: 0x13, scan: 0x45 });
    expect(codeToKey('ContextMenu')).toEqual({ vk: 0x5d, scan: 0xe05d });
    expect(codeToKey('OSLeft')).toEqual(codeToKey('MetaLeft'));
    for (let n = 1; n <= 24; n++) expect(codeToKey(`F${n}`), `F${n}`).toEqual({ vk: 0x6f + n, scan: expect.any(Number) });
    expect(codeToKey('F24')).toEqual({ vk: 0x87, scan: 0x76 });
    expect(codeToKey('F21')).toEqual({ vk: 0x84, scan: 0x6c });
  });

  test('every extended key keeps the 0xe0 prefix in the high byte', () => {
    for (const code of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'NumpadDivide', 'ControlRight', 'MetaRight']) {
      expect(codeToKey(code)!.scan >> 8, code).toBe(0xe0);
    }
  });

  test('unmapped or unknown codes yield null', () => {
    for (const code of ['', 'Unidentified', 'Lang1', 'KeyAA', 'keya', 'Fn', 'MediaPlayPause']) expect(codeToKey(code), code).toBeNull();
  });

  test('text and control hints follow the Swift Key flags', () => {
    expect(codeToKeyInfo('KeyA')).toMatchObject({ text: true });
    expect(codeToKeyInfo('Space')).toMatchObject({ text: true });
    expect(codeToKeyInfo('Numpad5')).toMatchObject({ text: true });
    expect(codeToKeyInfo('Enter')).toMatchObject({ control: 13, text: false });
    expect(codeToKeyInfo('NumpadEnter')).toMatchObject({ control: 13 });
    expect(codeToKeyInfo('Tab')).toMatchObject({ control: 9 });
    expect(codeToKeyInfo('Backspace')).toMatchObject({ control: 8 });
    expect(codeToKeyInfo('Escape')).toMatchObject({ control: 27 });
    expect(codeToKeyInfo('ArrowLeft')).toMatchObject({ text: false });
    expect(codeToKeyInfo('F1')).toMatchObject({ text: false });
    expect(codeToKeyInfo('ShiftLeft')).toMatchObject({ text: false });
    expect(codeToKeyInfo('NumLock')).toMatchObject({ text: false });
  });
});
