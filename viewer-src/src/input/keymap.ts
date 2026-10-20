// KeyboardEvent.code (UI Events physical position) -> Windows virtual-key / scan code.
// Ports the Swift MacRemoteInputEncoder.mapping table (Apple kVK_* positions) onto
// browser `code` names; E0-prefixed keys keep the prefix in the 16-bit scan value.
// Positions, not layouts: the host maps VK as a US layout, like the Swift viewer.

export interface KeyInfo {
  vk: number;
  scan: number;
  /** Printable key whose ASCII `key` value may be sent as the packet's character. */
  text: boolean;
  /** Fixed character for Enter/Tab/Backspace/Esc (13/9/8/27). */
  control?: number;
}

const table = new Map<string, KeyInfo>();

function add(code: string, vk: number, scan: number, opts: { text?: true; control?: number } = {}): void {
  table.set(code, { vk, scan, text: opts.text === true, ...(opts.control === undefined ? {} : { control: opts.control }) });
}

// Letters (VK = ASCII upper case) with their Set-1 make codes.
const letters: Record<string, number> = {
  A: 0x1e, B: 0x30, C: 0x2e, D: 0x20, E: 0x12, F: 0x21, G: 0x22, H: 0x23, I: 0x17, J: 0x24, K: 0x25, L: 0x26, M: 0x32,
  N: 0x31, O: 0x18, P: 0x19, Q: 0x10, R: 0x13, S: 0x1f, T: 0x14, U: 0x16, V: 0x2f, W: 0x11, X: 0x2d, Y: 0x15, Z: 0x2c,
};
for (const [letter, scan] of Object.entries(letters)) add(`Key${letter}`, letter.charCodeAt(0), scan, { text: true });

// Digit row: 1..9 then 0 (scan 0x02..0x0b).
for (let i = 0; i < 10; i++) {
  const digit = (i + 1) % 10;
  add(`Digit${digit}`, 0x30 + digit, 0x02 + i, { text: true });
}

// US punctuation (OEM VKs).
add('Equal', 0xbb, 0x0d, { text: true });
add('Minus', 0xbd, 0x0c, { text: true });
add('BracketRight', 0xdd, 0x1b, { text: true });
add('BracketLeft', 0xdb, 0x1a, { text: true });
add('Quote', 0xde, 0x28, { text: true });
add('Semicolon', 0xba, 0x27, { text: true });
add('Backslash', 0xdc, 0x2b, { text: true });
add('Comma', 0xbc, 0x33, { text: true });
add('Slash', 0xbf, 0x35, { text: true });
add('Period', 0xbe, 0x34, { text: true });
add('Backquote', 0xc0, 0x29, { text: true });
add('IntlBackslash', 0xe2, 0x56, { text: true }); // ISO extra key, VK_OEM_102
add('Space', 0x20, 0x39, { text: true });

add('Enter', 0x0d, 0x1c, { control: 13 });
add('Tab', 0x09, 0x0f, { control: 9 });
add('Backspace', 0x08, 0x0e, { control: 8 });
add('Escape', 0x1b, 0x01, { control: 27 });
add('CapsLock', 0x14, 0x3a);

// Modifiers. Meta/Command -> LWIN/RWIN, Alt/Option -> LMENU/RMENU.
add('ShiftLeft', 0xa0, 0x2a);
add('ShiftRight', 0xa1, 0x36);
add('ControlLeft', 0xa2, 0x1d);
add('ControlRight', 0xa3, 0xe01d);
add('AltLeft', 0xa4, 0x38);
add('AltRight', 0xa5, 0xe038);
add('MetaLeft', 0x5b, 0xe05b);
add('MetaRight', 0x5c, 0xe05c);
add('OSLeft', 0x5b, 0xe05b); // pre-118 Firefox spelling of MetaLeft
add('OSRight', 0x5c, 0xe05c);

// Keypad.
add('NumpadDecimal', 0x6e, 0x53, { text: true });
add('NumpadMultiply', 0x6a, 0x37, { text: true });
add('NumpadAdd', 0x6b, 0x4e, { text: true });
add('NumpadDivide', 0x6f, 0xe035, { text: true });
add('NumpadEnter', 0x0d, 0xe01c, { control: 13 });
add('NumpadSubtract', 0x6d, 0x4a, { text: true });
add('NumpadEqual', 0xbb, 0x59, { text: true }); // Swift: US OEM_PLUS
// Browser NumLock is VK_NUMLOCK (ruling P1-R6). Swift sent VK_CLEAR (0x0c/0x4c) for the Mac keypad Clear key;
// browsers report that key as NumLock too, and it deliberately toggles NumLock on the remote here.
add('NumLock', 0x90, 0x45);
const numpadScan = [0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49];
numpadScan.forEach((scan, n) => add(`Numpad${n}`, 0x60 + n, scan, { text: true }));

// Function keys: F1..F10 are scan 0x3b..0x44 / VK 0x70..; the rest are listed explicitly.
for (let n = 1; n <= 10; n++) add(`F${n}`, 0x6f + n, 0x3a + n);
add('F11', 0x7a, 0x57);
add('F12', 0x7b, 0x58);
const highFunctionScan = [0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x76];
highFunctionScan.forEach((scan, i) => add(`F${13 + i}`, 0x7c + i, scan));

// Navigation and editing. Mac "Help" sits where PC keyboards have Insert.
add('ContextMenu', 0x5d, 0xe05d);
add('Insert', 0x2d, 0xe052);
add('Help', 0x2d, 0xe052);
add('Home', 0x24, 0xe047);
add('PageUp', 0x21, 0xe049);
add('Delete', 0x2e, 0xe053);
add('End', 0x23, 0xe04f);
add('PageDown', 0x22, 0xe051);
add('ArrowLeft', 0x25, 0xe04b);
add('ArrowRight', 0x27, 0xe04d);
add('ArrowDown', 0x28, 0xe050);
add('ArrowUp', 0x26, 0xe048);
add('PrintScreen', 0x2c, 0xe037);
add('ScrollLock', 0x91, 0x46);
add('Pause', 0x13, 0x45);

/** Full mapping entry (includes the encoder-only `text` / `control` hints), or null for an unmapped code. */
export function codeToKeyInfo(code: string): Readonly<KeyInfo> | null {
  return table.get(code) ?? null;
}

/** Windows VK and Set-1 scan code for a physical key, or null when the position has no mapping. */
export function codeToKey(code: string): { vk: number; scan: number } | null {
  const info = table.get(code);
  return info ? { vk: info.vk, scan: info.scan } : null;
}
