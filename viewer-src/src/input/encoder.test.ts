import { describe, expect, test } from 'vitest';
import { InputEncoder } from './encoder';
import type { KeyInput } from './encoder';
import { u8 } from '../proto/test-utils';

const NONE = { ctrl: false, alt: false, meta: false, shift: false, capsLock: false, repeat: false };
function ev(code: string, key: string, over: Partial<KeyInput> = {}): KeyInput {
  return { code, key, ...NONE, ...over };
}
const bin = () => new InputEncoder({ binaryKeyboard: true });
const pkt = (kind: number, vk: number, scan: number, ch = 0, caps = 0): Uint8Array =>
  u8(30, 124, 124, 124, kind, vk, scan & 0xff, scan >> 8, ch & 0xff, ch >> 8, caps);
/** [kind, vk] of each 11-byte packet. */
const kv = (packets: Uint8Array[]): [number, number][] => packets.map((p) => [p[4]!, p[5]!]);

// Ported from MacRemoteInputEncoderTests.swift (kVK inputs replaced by KeyboardEvent.code).
describe('keyboard (MacRemoteInputEncoderTests.swift)', () => {
  test('asciiAndHeldKey: US position, ASCII hint and repeat re-send use the recovered eleven bytes', () => {
    const encoder = bin();
    const down = ev('KeyA', 'a');
    const expectedDown = u8(30, 124, 124, 124, 1, 0x41, 0x1e, 0, 0x61, 0, 0);
    expect(encoder.keyDown(down)).toEqual([expectedDown]);
    expect(encoder.keyDown({ ...down, repeat: true })).toEqual([expectedDown]);
    expect(encoder.releaseAll()).toEqual([u8(30, 124, 124, 124, 2, 0x41, 0x1e, 0, 0x61, 0, 0)]);
    expect(encoder.releaseAll()).toEqual([]);
    expect(encoder.keyUp(ev('KeyA', 'a'))).toEqual([]);
  });

  test('navigationAndFunctionKeys carry no character for non-text keys', () => {
    const cases: [string, number, number][] = [
      ['ArrowLeft', 0x25, 0xe04b], ['ArrowRight', 0x27, 0xe04d], ['ArrowDown', 0x28, 0xe050], ['ArrowUp', 0x26, 0xe048],
      ['Home', 0x24, 0xe047], ['Delete', 0x2e, 0xe053], ['F1', 0x70, 0x003b], ['F12', 0x7b, 0x0058], ['F20', 0x83, 0x006b],
    ];
    for (const [code, vk, scan] of cases) {
      // A browser reports key names like "ArrowLeft"; the Swift AppKit private-use character is gone.
      expect(bin().keyDown(ev(code, code)), code).toEqual([pkt(1, vk, scan)]);
    }
  });

  test('characterBoundaries: Backspace is character 8; non-ASCII takes only the physical-key path; unmapped is ignored', () => {
    const encoder = bin();
    expect(encoder.keyDown(ev('Backspace', 'Backspace'))).toEqual([u8(30, 124, 124, 124, 1, 8, 14, 0, 8, 0, 0)]);
    expect(encoder.keyDown(ev('KeyA', 'é'))).toEqual([u8(30, 124, 124, 124, 1, 0x41, 0x1e, 0, 0, 0, 0)]);
    expect(encoder.keyDown(ev('Unidentified', 'x'))).toEqual([]);
    // Enter 13, Tab 9, Esc 27 are fixed characters; a dead/composition key name is no character.
    expect(bin().keyDown(ev('Enter', 'Enter'))).toEqual([pkt(1, 0x0d, 0x1c, 13)]);
    expect(bin().keyDown(ev('NumpadEnter', 'Enter'))).toEqual([pkt(1, 0x0d, 0xe01c, 13)]);
    expect(bin().keyDown(ev('Tab', 'Tab'))).toEqual([pkt(1, 0x09, 0x0f, 9)]);
    expect(bin().keyDown(ev('Escape', 'Escape'))).toEqual([pkt(1, 0x1b, 0x01, 27)]);
    expect(bin().keyDown(ev('Space', ' '))).toEqual([pkt(1, 0x20, 0x39, 0x20)]);
    expect(bin().keyDown(ev('Digit1', '!', { shift: true }))).toEqual([pkt(1, 0xa0, 0x2a), pkt(1, 0x31, 0x02, 0x21)]);
    expect(bin().keyDown(ev('KeyA', 'Dead'))).toEqual([pkt(1, 0x41, 0x1e, 0)]);
    expect(bin().keyDown(ev('Numpad5', '5'))).toEqual([pkt(1, 0x65, 0x4c, 0x35)]);
    // A non-text key never takes a character even if `key` is one ASCII char.
    expect(bin().keyDown(ev('ArrowUp', 'x'))).toEqual([pkt(1, 0x26, 0xe048, 0)]);
    // DEL (0x7f) is outside printable ASCII.
    expect(bin().keyDown(ev('KeyA', '\u007f'))).toEqual([pkt(1, 0x41, 0x1e, 0)]);
  });

  test('inputMethodText: VK_PACKET down/up pairs, one per UTF-16 unit', () => {
    const encoder = bin();
    // "ệ" is U+1EC7; Vietnamese precomposed letters are single BMP units.
    expect(encoder.text('aệ')).toEqual([
      u8(30, 124, 124, 124, 1, 0xe7, 0, 0, 0x61, 0x00, 0),
      u8(30, 124, 124, 124, 2, 0xe7, 0, 0, 0x61, 0x00, 0),
      u8(30, 124, 124, 124, 1, 0xe7, 0, 0, 0xc7, 0x1e, 0),
      u8(30, 124, 124, 124, 2, 0xe7, 0, 0, 0xc7, 0x1e, 0),
    ]);
    // Control characters and surrogate halves (emoji) have no VK_PACKET form here.
    expect(encoder.text('\n😀')).toEqual([]);
    expect(encoder.text('😀')).toEqual([]);
    expect(encoder.text('')).toEqual([]);
    // Text holds no key, so a following release has nothing to release.
    expect(encoder.releaseAll()).toEqual([]);
    expect(new InputEncoder({ binaryKeyboard: false }).text('ệ')).toEqual([]);
  });

  test('text takes the caps state of the last key event', () => {
    const encoder = bin();
    encoder.keyDown(ev('KeyA', 'A', { capsLock: true }));
    expect(encoder.text('b')[0]).toEqual(u8(30, 124, 124, 124, 1, 0xe7, 0, 0, 0x62, 0, 1));
  });

  test('modifier flags synthesize left keys before the key; releaseAll releases the ordinary key first', () => {
    const encoder = bin();
    // Ctrl+Shift+C: shift/ctrl are held by flag only (focus arrived with them down).
    const shortcut = encoder.keyDown(ev('KeyC', 'C', { ctrl: true, shift: true }));
    expect(shortcut).toEqual([pkt(1, 0xa0, 0x2a), pkt(1, 0xa2, 0x1d), pkt(1, 0x43, 0x2e, 0)]);
    const release = encoder.releaseAll() as Uint8Array[];
    expect(release.map((p) => p[5])).toEqual([0x43, 0xa2, 0xa0]);
    expect(release.every((p) => p[4] === 2)).toBe(true);
    expect(encoder.releaseAll()).toEqual([]);
  });

  test('a repeated key with the same flags sends no extra modifier packets', () => {
    const encoder = bin();
    encoder.keyDown(ev('ControlLeft', 'Control', { ctrl: true }));
    expect(encoder.keyDown(ev('KeyC', 'c', { ctrl: true }))).toEqual([pkt(1, 0x43, 0x2e, 0)]);
    expect(encoder.keyDown(ev('KeyC', 'c', { ctrl: true, repeat: true }))).toEqual([pkt(1, 0x43, 0x2e, 0)]);
    expect(encoder.keyDown(ev('ControlLeft', 'Control', { ctrl: true, repeat: true }))).toEqual([]);
  });

  test('sideSpecificModifiers: each side keeps its own Windows identity, Alt uses kinds 3/4', () => {
    const cases: [string, 'shift' | 'ctrl' | 'alt' | 'meta', number, number, number][] = [
      ['ShiftLeft', 'shift', 0xa0, 0x002a, 1], ['ShiftRight', 'shift', 0xa1, 0x0036, 1],
      ['ControlLeft', 'ctrl', 0xa2, 0x001d, 1], ['ControlRight', 'ctrl', 0xa3, 0xe01d, 1],
      ['AltLeft', 'alt', 0xa4, 0x0038, 3], ['AltRight', 'alt', 0xa5, 0xe038, 3],
      ['MetaLeft', 'meta', 0x5b, 0xe05b, 1], ['MetaRight', 'meta', 0x5c, 0xe05c, 1],
    ];
    for (const [code, flag, vk, scan, kind] of cases) {
      const encoder = bin();
      expect(encoder.keyDown(ev(code, code, { [flag]: true })), code).toEqual([pkt(kind, vk, scan)]);
      expect(encoder.keyDown(ev(code, code, { [flag]: true, repeat: true })), code).toEqual([]);
      expect(encoder.keyUp(ev(code, code)), code).toEqual([pkt(kind + 1, vk, scan)]);
      expect(encoder.releaseAll(), code).toEqual([]);
    }
  });

  test('a pressed modifier counts as held even when the caller forgot its flag', () => {
    const encoder = bin();
    expect(encoder.keyDown(ev('ShiftLeft', 'Shift'))).toEqual([pkt(1, 0xa0, 0x2a)]);
  });

  test('modifierSideReconciliation: a concrete right Shift replaces a guessed left Shift; both sides can be held', () => {
    const encoder = bin();
    // Shift was down before focus: the first key synthesizes the left side.
    expect(kv(encoder.keyDown(ev('KeyX', 'X', { shift: true })))).toEqual([[1, 0xa0], [1, 0x58]]);
    encoder.keyUp(ev('KeyX', 'X', { shift: true }));
    const replace = encoder.keyDown(ev('ShiftRight', 'Shift', { shift: true }));
    expect(kv(replace)).toEqual([[2, 0xa0], [1, 0xa1]]);
    expect(encoder.keyDown(ev('ShiftLeft', 'Shift', { shift: true }))).toHaveLength(1);
    expect(kv(encoder.keyUp(ev('ShiftLeft', 'Shift', { shift: true })))).toEqual([[2, 0xa0]]);
    // Both sides released: the flag clears, the right side goes up.
    expect(kv(encoder.keyUp(ev('ShiftRight', 'Shift')))).toEqual([[2, 0xa1]]);
    expect(encoder.releaseAll()).toEqual([]);
  });

  test('a flag that dropped while the page was not listening releases the held modifier', () => {
    const encoder = bin();
    encoder.keyDown(ev('ShiftLeft', 'Shift', { shift: true }));
    expect(kv(encoder.keyDown(ev('KeyA', 'a')))).toEqual([[2, 0xa0], [1, 0x41]]);
  });

  test('Alt held: every key uses kinds 3/4, including its release after Alt goes up', () => {
    const encoder = bin();
    expect(encoder.keyDown(ev('AltLeft', 'Alt', { alt: true }))).toEqual([pkt(3, 0xa4, 0x38)]);
    expect(encoder.keyDown(ev('KeyF', 'f', { alt: true }))).toEqual([pkt(3, 0x46, 0x21, 0)]);
    expect(encoder.keyDown(ev('F4', 'F4', { alt: true }))).toEqual([pkt(3, 0x73, 0x3e, 0)]);
    expect(encoder.keyUp(ev('KeyF', 'f', { alt: true }))).toEqual([pkt(4, 0x46, 0x21, 0)]);
    // F4 was pressed under Alt, so it is released as a system key even after Alt is up.
    expect(encoder.keyUp(ev('AltLeft', 'Alt'))).toEqual([pkt(4, 0xa4, 0x38)]);
    expect(encoder.keyUp(ev('F4', 'F4'))).toEqual([pkt(4, 0x73, 0x3e, 0)]);
    expect(encoder.keyDown(ev('KeyF', 'f'))).toEqual([pkt(1, 0x46, 0x21, 0x66)]);
  });

  test('Meta keyup releases keys whose keyup the browser swallowed (macOS), before the Win key', () => {
    const encoder = bin();
    encoder.keyDown(ev('MetaLeft', 'Meta', { meta: true }));
    encoder.keyDown(ev('KeyC', 'c', { meta: true }));
    encoder.keyDown(ev('KeyV', 'v', { meta: true }));
    // Neither keyup for C nor V ever arrives while Cmd is down.
    expect(kv(encoder.keyUp(ev('MetaLeft', 'Meta')))).toEqual([[2, 0x56], [2, 0x43], [2, 0x5b]]);
    expect(encoder.releaseAll()).toEqual([]);
  });

  test('Meta keyup keeps ordinary keys while the other Meta side is still down', () => {
    const encoder = bin();
    encoder.keyDown(ev('MetaLeft', 'Meta', { meta: true }));
    encoder.keyDown(ev('MetaRight', 'Meta', { meta: true }));
    encoder.keyDown(ev('KeyC', 'c', { meta: true }));
    expect(kv(encoder.keyUp(ev('MetaLeft', 'Meta', { meta: true })))).toEqual([[2, 0x5b]]);
  });

  test('IME composition: keydown with key "Process" is ignored, its keyup still releases a held key', () => {
    const encoder = bin();
    expect(encoder.keyDown(ev('KeyA', 'Process'))).toEqual([]);
    expect(encoder.releaseAll()).toEqual([]);
    encoder.keyDown(ev('KeyA', 'a'));
    expect(kv(encoder.keyUp(ev('KeyA', 'Process')))).toEqual([[2, 0x41]]);
  });

  test('CapsLock is a tap per physical press and ignores repeat and keyup', () => {
    const encoder = bin();
    expect(kv(encoder.keyDown(ev('CapsLock', 'CapsLock', { capsLock: true })))).toEqual([[1, 0x14], [2, 0x14]]);
    expect(encoder.keyDown(ev('CapsLock', 'CapsLock', { capsLock: true, repeat: true }))).toEqual([]);
    expect(encoder.keyUp(ev('CapsLock', 'CapsLock', { capsLock: true }))).toEqual([]);
    expect(encoder.releaseAll()).toEqual([]);
  });

  test('capsAndCapability: caps rides real keyboard packets; legacy peers get no key packets', () => {
    const encoder = bin();
    expect(encoder.keyDown(ev('KeyA', 'A', { capsLock: true }))).toEqual([u8(30, 124, 124, 124, 1, 0x41, 0x1e, 0, 0x41, 0, 1)]);
    const release = encoder.releaseAll() as Uint8Array[];
    expect(release.at(-1)!.at(-1)).toBe(1);
    // Caps stays known after releaseAll.
    expect(encoder.text('x')[0]!.at(-1)).toBe(1);

    const legacy = new InputEncoder({ binaryKeyboard: false });
    expect(legacy.keyDown(ev('ShiftLeft', 'Shift', { shift: true }))).toEqual([]);
    expect(legacy.keyDown(ev('KeyA', 'A', { shift: true }))).toEqual([]);
    expect(legacy.keyUp(ev('KeyA', 'A', { shift: true }))).toEqual([]);
    expect(legacy.pointerMove({ x: 1, y: 2 }, 0)).toEqual(['8|||512|||4|||1|||2']);
    expect(legacy.releaseAll()).toEqual([]);
  });

  test('releaseAll after Shift+A and a left mouse button: key up A, mouse up, key up Shift', () => {
    const encoder = bin();
    encoder.keyDown(ev('ShiftLeft', 'Shift', { shift: true }));
    encoder.keyDown(ev('KeyA', 'A', { shift: true }));
    encoder.pointerDown(0, { x: 10, y: 20 });
    expect(encoder.releaseAll()).toEqual([
      pkt(2, 0x41, 0x1e, 0x41),
      mouseUp(0x202, 0x04, 10, 20),
      pkt(2, 0xa0, 0x2a),
    ]);
    expect(encoder.releaseAll()).toEqual([]);
  });
});

function mouseUp(msg: number, flags: number, x: number, y: number): string {
  return `8|||${msg}|||${flags}|||${((y & 0xffff) << 16) | (x & 0xffff)}`;
}

describe('mouse (MacRemoteInputEncoderTests.swift pointerButtonReleases)', () => {
  test('clicks move first, preserve held flags and release only held buttons (reverse press order)', () => {
    const encoder = bin();
    encoder.keyDown(ev('ControlLeft', 'Control', { ctrl: true }));
    expect(encoder.pointerDown(0, { x: 30, y: 40 })).toEqual(['8|||512|||8|||30|||40', '8|||513|||9|||2621470']);
    expect(encoder.pointerDown(0, { x: 30, y: 40 })).toEqual([]);
    expect(encoder.pointerMove({ x: 31, y: 40 }, 1)).toEqual(['8|||512|||9|||31|||40']);
    // Browser button 2 is the right button (Swift button 1).
    expect(encoder.pointerDown(2, { x: 31, y: 40 })).toEqual(['8|||512|||9|||31|||40', '8|||516|||11|||2621471']);
    const release = encoder.releaseAll();
    expect(release.slice(0, 2)).toEqual(['8|||517|||9|||2621471', '8|||514|||8|||2621471']);
    expect(release).toHaveLength(3);
    expect(Array.from((release[2] as Uint8Array).slice(4, 6))).toEqual([2, 0xa2]);
    expect(encoder.releaseAll()).toEqual([]);
    expect(encoder.pointerDown(3 as 0, { x: 1, y: 1 })).toEqual([]);
  });

  test('wParam flags: left 0x01, right 0x02, middle 0x10, shift 0x04, control 0x08', () => {
    const encoder = bin();
    encoder.keyDown(ev('ShiftLeft', 'Shift', { shift: true }));
    expect(encoder.pointerDown(1, { x: 5, y: 6 })).toEqual(['8|||512|||4|||5|||6', `8|||519|||20|||${(6 << 16) | 5}`]);
    // Like Swift, the release re-sends the position because the held-button flags changed since the last move,
    // and the up message itself no longer carries the released button.
    expect(encoder.pointerUp(1, { x: 5, y: 6 })).toEqual(['8|||512|||20|||5|||6', `8|||520|||4|||${(6 << 16) | 5}`]);
    encoder.pointerDown(0, { x: 5, y: 6 });
    encoder.pointerDown(2, { x: 5, y: 6 });
    expect(encoder.pointerUp(2, { x: 5, y: 6 })).toEqual(['8|||512|||7|||5|||6', `8|||517|||5|||${(6 << 16) | 5}`]);
  });

  test('a button release at a new position sends the move first; a release of an unheld button is empty', () => {
    const encoder = bin();
    expect(encoder.pointerUp(0, { x: 1, y: 1 })).toEqual([]);
    encoder.pointerDown(0, { x: 1, y: 1 });
    expect(encoder.pointerUp(0, { x: 7, y: 8 })).toEqual(['8|||512|||1|||7|||8', `8|||514|||0|||${(8 << 16) | 7}`]);
  });

  test('the same position and flags emit no duplicate move; a flag change does', () => {
    const encoder = bin();
    expect(encoder.pointerMove({ x: 3, y: 4 })).toEqual(['8|||512|||0|||3|||4']);
    expect(encoder.pointerMove({ x: 3, y: 4 })).toEqual([]);
    encoder.keyDown(ev('ControlLeft', 'Control', { ctrl: true }));
    expect(encoder.pointerMove({ x: 3, y: 4 })).toEqual(['8|||512|||8|||3|||4']);
  });

  test('negative remote coordinates pack as Int16 words and send as signed text in a move', () => {
    const encoder = bin();
    expect(encoder.pointerDown(0, { x: -1920, y: -5 })).toEqual([
      '8|||512|||0|||-1920|||-5',
      `8|||513|||1|||${(((-5 & 0xffff) << 16) | (-1920 & 0xffff)) | 0}`,
    ]);
  });

  test('out-of-range coordinates: lParam truncates to Int16 like Swift, move text clamps to Int32, NaN is ignored', () => {
    const encoder = bin();
    // 40000 = 0x9c40 -> Int16 -25536; 70000 = 0x11170 -> 0x1170 = 4464.
    expect(encoder.pointerDown(0, { x: 40000, y: 70000 })).toEqual([
      '8|||512|||0|||40000|||70000',
      `8|||513|||1|||${((4464 << 16) | (-25536 & 0xffff)) | 0}`,
    ]);
    const clamped = bin();
    expect(clamped.pointerMove({ x: 1e12, y: -1e12 })).toEqual(['8|||512|||0|||2147483647|||-2147483648']);
    expect(clamped.pointerMove({ x: 3.9, y: -3.9 })).toEqual(['8|||512|||0|||3|||-3']);
    const nan = bin();
    expect(nan.pointerMove({ x: NaN, y: 1 })).toEqual([]);
    expect(nan.pointerDown(0, { x: 1, y: Infinity })).toEqual([]);
    // A release with an unusable point reuses the last good position.
    nan.pointerDown(0, { x: 2, y: 3 });
    expect(nan.pointerUp(0, { x: NaN, y: NaN })).toEqual([`8|||514|||0|||${(3 << 16) | 2}`]);
  });

  test('MouseEvent.buttons reconciliation releases a button the page never saw go up', () => {
    const encoder = bin();
    encoder.pointerDown(0, { x: 5, y: 5 });
    encoder.pointerDown(2, { x: 5, y: 5 });
    // Only the right button (bit 2) is still down.
    expect(encoder.pointerMove({ x: 6, y: 5 }, 2)).toEqual(['8|||512|||3|||6|||5', `8|||514|||2|||${(5 << 16) | 6}`]);
    // Nothing down any more.
    expect(encoder.pointerMove({ x: 7, y: 5 }, 0)).toEqual(['8|||512|||2|||7|||5', `8|||517|||0|||${(5 << 16) | 7}`]);
    expect(encoder.releaseAll()).toEqual([]);
    // Middle uses bit 4.
    encoder.pointerDown(1, { x: 1, y: 1 });
    expect(encoder.pointerMove({ x: 1, y: 1 }, 4)).toEqual(['8|||512|||16|||1|||1']);
    expect(encoder.pointerMove({ x: 1, y: 1 }, 4)).toEqual([]);
    expect(encoder.releaseAll()).toEqual([`8|||520|||0|||${(1 << 16) | 1}`]);
  });
});

describe('wheel (RemoteScrollTests.swift, MacRemoteInputEncoderTests verticalWheel)', () => {
  test('small trackpad events accumulate into one Windows wheel notch', () => {
    const encoder = bin();
    const out: string[] = [];
    for (let i = 0; i < 8; i++) out.push(...encoder.wheel(-5, 'pixel'));
    expect(out).toEqual(['8|||522|||7864320|||0']);
  });

  test('scrolling down (positive deltaY) is a negative wheel delta', () => {
    const encoder = bin();
    const out: string[] = [];
    for (let i = 0; i < 8; i++) out.push(...encoder.wheel(5, 'pixel'));
    expect(out).toEqual(['8|||522|||-7864320|||0']);
  });

  test('units: pixel/40, line/3, page*3 notches, 120 per notch', () => {
    expect(bin().wheel(40, 'pixel')).toEqual(['8|||522|||-7864320|||0']);
    expect(bin().wheel(3, 'line')).toEqual(['8|||522|||-7864320|||0']);
    expect(bin().wheel(1, 'line')).toEqual([]);
    expect(bin().wheel(-1, 'page')).toEqual([`8|||522|||${(360 << 16) | 0}|||0`]);
    expect(bin().wheel(-0.5, 'page')).toEqual([`8|||522|||${(120 << 16) | 0}|||0`]);
    expect(bin().wheel(2, 'page')).toEqual([`8|||522|||${(-720 << 16) | 0}|||0`]);
  });

  test('fractions accumulate across calls; a reversed direction pays the remainder back', () => {
    const encoder = bin();
    expect(encoder.wheel(-0.5 * 40, 'pixel')).toEqual([]);
    expect(encoder.wheel(-0.5 * 40, 'pixel')).toEqual(['8|||522|||7864320|||0']);
    expect(encoder.wheel(1 * 40, 'pixel')).toEqual(['8|||522|||-7864320|||0']);
    expect(encoder.wheel(30, 'pixel')).toEqual([]);
    expect(encoder.wheel(-30, 'pixel')).toEqual([]);
    expect(encoder.wheel(0, 'pixel')).toEqual([]);
  });

  test('non-finite deltas are ignored; a huge delta clamps to 256 notches (30720)', () => {
    const encoder = bin();
    expect(encoder.wheel(Infinity, 'pixel')).toEqual([]);
    expect(encoder.wheel(NaN, 'line')).toEqual([]);
    expect(encoder.wheel(-Infinity, 'page')).toEqual([]);
    expect(encoder.wheel(-Number.MAX_VALUE, 'pixel')).toEqual([`8|||522|||${(30720 << 16) | 0}|||0`]);
    expect(encoder.wheel(Number.MAX_VALUE, 'page')).toEqual([`8|||522|||${(-30720 << 16) | 0}|||0`]);
    expect(bin().wheel(-256 * 40, 'pixel')).toEqual([`8|||522|||${(30720 << 16) | 0}|||0`]);
  });

  test('wheel carries the held modifier flags and the pointer lParam; releaseAll clears the remainder', () => {
    const encoder = bin();
    encoder.keyDown(ev('ControlLeft', 'Control', { ctrl: true }));
    encoder.pointerMove({ x: 30, y: 40 });
    expect(encoder.wheel(-40, 'pixel')).toEqual([`8|||522|||${(120 << 16) | 8}|||2621470`]);
    encoder.wheel(-20, 'pixel');
    encoder.releaseAll();
    expect(encoder.wheel(-20, 'pixel')).toEqual([]);
  });
});
