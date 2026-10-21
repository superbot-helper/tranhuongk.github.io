// Port of UltraViewerProtocol/ClipboardProtocol.swift (the viewer side only).
// Text clipboard application payloads. The caller owns consent, session/route
// authentication, direction permissions, clipboard access and echo suppression.
import { ZstdScreenDecoder } from '../codec/zstd-decoder';
import type { RemoteMessage } from './commands';
import { decodeUtf16leStrict, toWellFormed, utf16le } from './utf16';

export type ClipboardErrorCode =
  | 'malformedMessage'
  | 'unsupportedCommand'
  | 'invalidText'
  | 'unsupportedLegacyDelimiter'
  | 'sizeLimitExceeded'
  | 'decompressedLengthMismatch';

/** The message carries only the code (and lengths): never the clipboard text. */
export class ClipboardError extends Error {
  readonly code: ClipboardErrorCode;
  /** decompressedLengthMismatch only. */
  readonly expected?: number;
  readonly received?: number;
  constructor(code: ClipboardErrorCode, detail: { expected?: number; received?: number } = {}) {
    super(detail.expected === undefined ? code : `${code}(expected: ${detail.expected}, received: ${detail.received})`);
    this.name = 'ClipboardError';
    this.code = code;
    Object.assign(this, detail);
  }
}

/** Local text-only limits, independent of the Windows implementation limits. */
export const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;
export const MAX_CLIPBOARD_PAYLOAD_BYTES = 2 * 1024 * 1024;

/** The zstd frame block maximum (zstd format: Block_Maximum_Size = 128 KiB). */
const ZSTD_BLOCK_MAX = 128 * 1024;

/**
 * Decompress `bytes` (a fresh, dictionary-free zstd stream) to exactly the
 * decoder's output. `expected` is the announced length; the caller checks it.
 */
export type ClipboardZstd = (bytes: Uint8Array, expected: number) => Uint8Array;

function encodeText(text: string): Uint8Array {
  const wellFormed = toWellFormed(text);
  if (wellFormed.length > MAX_CLIPBOARD_TEXT_BYTES / 2) throw new ClipboardError('sizeLimitExceeded');
  if (wellFormed.includes('\0')) throw new ClipboardError('invalidText');
  return utf16le(wellFormed);
}

/**
 * A standard zstd frame holding `data` in stored (raw) blocks: single-segment,
 * 4-byte content size, no checksum, blocks of at most 128 KiB. The browser sends
 * clipboard text this way instead of porting a compressor; any zstd decoder,
 * including the host's, reads it. The Swift fixture (22 bytes) is
 * `28 b5 2f fd a0 16 00 00 00 b1 00 00` + data.
 */
export function rawZstdFrame(data: Uint8Array): Uint8Array {
  if (data.length > 0xffffffff) throw new RangeError('data too large for a zstd frame');
  const blocks = Math.max(1, Math.ceil(data.length / ZSTD_BLOCK_MAX));
  const frame = new Uint8Array(9 + blocks * 3 + data.length);
  frame.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0]);
  new DataView(frame.buffer).setUint32(5, data.length, true);
  let out = 9;
  for (let block = 0; block < blocks; block++) {
    const start = block * ZSTD_BLOCK_MAX;
    const size = Math.min(ZSTD_BLOCK_MAX, data.length - start);
    const header = (size << 3) | (block === blocks - 1 ? 1 : 0); // raw block: type 0
    frame[out++] = header & 0xff;
    frame[out++] = (header >> 8) & 0xff;
    frame[out++] = (header >> 16) & 0xff;
    frame.set(data.subarray(start, start + size), out);
    out += size;
  }
  return frame;
}

/**
 * Controller→host modern payload. NOT LE32 multipart: only the ASCII header is
 * text; the appended zstd frame must be kept intact in transport (formatFlag
 * false). Empty text uses the established legacy command 5 path.
 */
export function clipboardPayload(text: string): RemoteMessage {
  const utf16 = encodeText(text);
  if (utf16.length === 0) return { bytes: utf16le('5|||'), formatFlag: true };
  const header = new TextEncoder().encode(`33|||${utf16.length}|||`);
  const frame = rawZstdFrame(utf16);
  const bytes = new Uint8Array(header.length + frame.length);
  bytes.set(header);
  bytes.set(frame, header.length);
  return { bytes, formatFlag: false };
}

/**
 * Legacy host: UTF-16LE command 5 including its delimiter prefix. Windows' IPC
 * splits every delimiter and consumes only field 1, so text containing one is
 * rejected rather than silently losing its suffix.
 */
export function clipboardPayloadLegacy(text: string): RemoteMessage {
  const utf16 = encodeText(text);
  if (utf16.length === 0) return { bytes: utf16le('5|||'), formatFlag: true };
  if (text.includes('|||')) throw new ClipboardError('unsupportedLegacyDelimiter');
  const prefix = utf16le('5|||');
  const bytes = new Uint8Array(prefix.length + utf16.length);
  bytes.set(prefix);
  bytes.set(utf16, prefix.length);
  return { bytes, formatFlag: true };
}

/**
 * Cached zstd for the page: one decoder created WITHOUT a dictionary (UVC
 * ordinal 50 uses a fresh one-shot context), reset before every call so a
 * failed stream never poisons the next. The output limit is the text limit.
 */
export async function makeClipboardZstd(maximumBytes = MAX_CLIPBOARD_TEXT_BYTES): Promise<ClipboardZstd> {
  const decoder = await ZstdScreenDecoder.create(null, maximumBytes);
  return (bytes) => {
    decoder.reset();
    const data = decoder.append(bytes);
    decoder.finish();
    return data;
  };
}

function decodeUtf16(data: Uint8Array, maximumBytes: number): string {
  if (data.length > maximumBytes) throw new ClipboardError('sizeLimitExceeded');
  if (data.length % 2 !== 0) throw new ClipboardError('invalidText');
  const text = decodeUtf16leStrict(data);
  if (text === null || text.includes('\0')) throw new ClipboardError('invalidText');
  return text;
}

function decodeCompressedText(compressed: Uint8Array, expected: number, zstd: ClipboardZstd): string {
  if (expected % 2 !== 0) throw new ClipboardError('invalidText');
  if (compressed.length === 0) throw new ClipboardError('malformedMessage');
  const decoded = zstd(compressed, expected);
  if (decoded.length !== expected) throw new ClipboardError('decompressedLengthMismatch', { expected, received: decoded.length });
  return decodeUtf16(decoded, MAX_CLIPBOARD_TEXT_BYTES);
}

/**
 * Decodes host→viewer modern multipart 33 (`[[33], Int32LE byteCount, zstd]`)
 * and the original uncompressed multipart 5 (`[[5], UTF-16LE]`). Clipboard/
 * session permissions are deliberately not implied by decoding. Any other
 * command throws unsupportedCommand, as in Swift.
 */
export function decodeClipboard(parts: Uint8Array[], zstd: ClipboardZstd): string {
  let total = 0;
  for (const part of parts) {
    if (part.length > MAX_CLIPBOARD_PAYLOAD_BYTES - total) throw new ClipboardError('sizeLimitExceeded');
    total += part.length;
  }
  const command = parts[0]?.[0];
  if (command === undefined) throw new ClipboardError('malformedMessage');
  switch (command) {
    case 33: {
      const size = parts[1];
      if (parts.length < 3 || size === undefined || size.length < 4) throw new ClipboardError('malformedMessage');
      const expected = (size[0]! | (size[1]! << 8) | (size[2]! << 16) | (size[3]! << 24)) >>> 0;
      if (expected > MAX_CLIPBOARD_TEXT_BYTES) throw new ClipboardError('sizeLimitExceeded');
      return decodeCompressedText(parts[2]!, expected, zstd);
    }
    case 5: {
      if (parts.length < 2) throw new ClipboardError('malformedMessage');
      return decodeUtf16(parts[1]!, MAX_CLIPBOARD_TEXT_BYTES);
    }
    default:
      throw new ClipboardError('unsupportedCommand');
  }
}
