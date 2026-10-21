// Shared text helpers for the chat, clipboard and file messages: UTF-16LE
// (the Windows "Unicode SendString" encoding) and the Swift String boundary.

/** UTF-16LE bytes of `text`, one little-endian code unit at a time. */
export function utf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    bytes[i * 2] = unit & 0xff;
    bytes[i * 2 + 1] = unit >> 8;
  }
  return bytes;
}

/**
 * Replace each unpaired surrogate with U+FFFD. A Swift String can never hold
 * one, so the Swift encoders never put an ill-formed UTF-16 sequence on the wire.
 */
export function toWellFormed(text: string): string {
  let out: string | undefined;
  let copied = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    } else if (!(unit >= 0xdc00 && unit <= 0xdfff)) {
      continue;
    }
    out = (out ?? '') + text.slice(copied, i) + '�';
    copied = i + 1;
  }
  return out === undefined ? text : out + text.slice(copied);
}

/** UTF-8 byte length of a well-formed string (Swift `String.utf8.count`). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const FROM_CHAR_CODE_BATCH = 8192;

/**
 * Strict UTF-16LE: even length, every high surrogate followed by a low one and
 * no lone low surrogate. Returns null on any violation. NUL and a leading BOM
 * are ordinary data (TextDecoder would strip the BOM, so it is not used).
 */
export function decodeUtf16leStrict(bytes: Uint8Array): string | null {
  if (bytes.length % 2 !== 0) return null;
  const units = new Array<number>(Math.min(bytes.length / 2, FROM_CHAR_CODE_BATCH));
  let result = '';
  let filled = 0;
  const flush = (): void => {
    result += String.fromCharCode(...(filled === units.length ? units : units.slice(0, filled)));
    filled = 0;
  };
  let index = 0;
  while (index < bytes.length) {
    const unit = bytes[index]! | (bytes[index + 1]! << 8);
    index += 2;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index >= bytes.length) return null;
      const low = bytes[index]! | (bytes[index + 1]! << 8);
      if (low < 0xdc00 || low > 0xdfff) return null;
      index += 2;
      if (filled + 2 > units.length) flush();
      units[filled++] = unit;
      units[filled++] = low;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    } else {
      if (filled === units.length) flush();
      units[filled++] = unit;
    }
  }
  if (filled > 0) flush();
  return result;
}
