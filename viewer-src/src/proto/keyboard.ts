// Port of UltraViewerProtocol/KeyboardMessage.swift.
// Eleven application bytes emitted by the desktop's SendKeyboardMsg, before routing,
// encryption and outer TCP framing. Send with formatFlag=false.

export type KeyboardKind = 1 | 2 | 3 | 4;

export interface KeyboardPacketInput {
  /** 1 key down, 2 key up, 3 system key down (Alt held), 4 system key up. */
  kind: KeyboardKind;
  /** UInt8 virtual-key code. */
  vk: number;
  /** UInt16 scan code (extended keys carry 0xe0 in the high byte). */
  scan: number;
  /** One UTF-16 code unit, not a Unicode scalar. */
  character: number;
  capsLock: boolean;
}

export type KeyboardMessageErrorCode = 'unsupportedWindowsMessage';

export class KeyboardMessageError extends Error {
  readonly code: KeyboardMessageErrorCode;
  /** Associated value of unsupportedWindowsMessage. */
  readonly windowsMessage: number;
  constructor(code: KeyboardMessageErrorCode, windowsMessage: number) {
    super(`${code}(${windowsMessage})`);
    this.name = 'KeyboardMessageError';
    this.code = code;
    this.windowsMessage = windowsMessage;
  }
}

/** Recovered VFunction.MsgToKBByte mapping (Swift `Kind.init(windowsMessage:)`). */
export function keyboardKindFromWindowsMessage(windowsMessage: number): KeyboardKind {
  switch (windowsMessage) {
    case 0x100:
      return 1;
    case 0x101:
      return 2;
    case 0x104:
      return 3;
    case 0x105:
      return 4;
    default:
      throw new KeyboardMessageError('unsupportedWindowsMessage', windowsMessage);
  }
}

function field(value: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`${name} out of range`);
  return value;
}

/** `[30, '|||', kind, vk, scanLE16, characterLE16, caps]`. */
export function keyboardPacket(k: KeyboardPacketInput): Uint8Array {
  const kind = field(k.kind, 4, 'kind');
  if (kind < 1) throw new RangeError('kind out of range');
  const vk = field(k.vk, 0xff, 'vk');
  const scan = field(k.scan, 0xffff, 'scan');
  const character = field(k.character, 0xffff, 'character');
  return new Uint8Array([30, 0x7c, 0x7c, 0x7c, kind, vk, scan & 0xff, scan >> 8, character & 0xff, character >> 8, k.capsLock ? 1 : 0]);
}
