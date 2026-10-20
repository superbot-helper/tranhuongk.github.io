// Port of UltraViewerProtocol/CursorMessage.swift.
// Already decrypted multipart cursor messages (decodeMultipart output). Shape
// selection, shape transfer and remote pointer position are separate commands;
// this module owns no cache, native cursor or session state.
import { ZstdScreenDecoder } from '../codec/zstd-decoder';

export type CursorMessageErrorCode =
  | 'unsupportedCommand'
  | 'missingPart'
  | 'malformedPart'
  | 'sizeLimitExceeded'
  | 'decompressedLengthMismatch'
  | 'invalidCursorFile';

/** Associated values of the Swift enum cases. */
export interface CursorMessageErrorDetail {
  /** unsupportedCommand */
  command?: number;
  /** missingPart / malformedPart */
  part?: number;
  /** decompressedLengthMismatch */
  expected?: number;
  received?: number;
}

export class CursorMessageError extends Error implements CursorMessageErrorDetail {
  readonly code: CursorMessageErrorCode;
  readonly command?: number;
  readonly part?: number;
  readonly expected?: number;
  readonly received?: number;
  constructor(code: CursorMessageErrorCode, detail: CursorMessageErrorDetail = {}) {
    const args = Object.entries(detail).map(([k, v]) => `${k}: ${String(v)}`);
    super(args.length ? `${code}(${args.join(', ')})` : code);
    this.name = 'CursorMessageError';
    this.code = code;
    Object.assign(this, detail);
  }
}

/** Command-3 hash that exits the inspected desktop branch without updating its cursor (signed Int32). */
export const IGNORED_SELECTION_HASH = 0xb84d1a70 | 0;

const DEFAULT_MAXIMUM_BYTES = 2 * 1024 * 1024;

export type CursorEvent =
  | { type: 'select'; hash: number }
  | { type: 'shape'; hash: number; cur: Uint8Array }
  | { type: 'position'; x: number; y: number };

/**
 * Decompress `bytes` (a fresh, dictionary-free zstd stream) to exactly the
 * decoder's output. `expected` is the length the peer announced; the caller
 * checks it, so an adapter may ignore it.
 */
export type CursorZstd = (bytes: Uint8Array, expected: number) => Uint8Array;

/** One CUR directory entry and its original image resource. */
export interface CursorFile {
  fileData: Uint8Array;
  resourceData: Uint8Array;
  imageCount: number;
  width: number;
  height: number;
  hotSpotX: number;
  hotSpotY: number;
}

function word(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function long(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/**
 * Local validation reads the complete 16-bit hotspots and 32-bit offset; the
 * inspected Windows loader truncates those values to their low byte.
 */
export function decodeCursorFile(data: Uint8Array, maximumBytes = DEFAULT_MAXIMUM_BYTES): CursorFile {
  if (!(maximumBytes > 0) || data.length > maximumBytes) throw new CursorMessageError('sizeLimitExceeded');
  if (data.length < 22 || word(data, 0) !== 0 || word(data, 2) !== 2) throw new CursorMessageError('invalidCursorFile');
  const imageCount = word(data, 4);
  const directoryEnd = 6 + imageCount * 16;
  if (imageCount === 0 || directoryEnd > data.length) throw new CursorMessageError('invalidCursorFile');
  const width = data[6] === 0 ? 256 : data[6]!;
  const height = data[7] === 0 ? 256 : data[7]!;
  const hotSpotX = word(data, 10);
  const hotSpotY = word(data, 12);
  const size = long(data, 14);
  const offset = long(data, 18);
  if (
    data[9] !== 0 ||
    hotSpotX >= width ||
    hotSpotY >= height ||
    size <= 0 ||
    offset < directoryEnd ||
    offset > data.length ||
    size > data.length - offset
  ) {
    throw new CursorMessageError('invalidCursorFile');
  }
  return { fileData: data, resourceData: data.slice(offset, offset + size), imageCount, width, height, hotSpotX, hotSpotY };
}

function part(parts: Uint8Array[], index: number, minimum: number): Uint8Array {
  const p = parts[index];
  if (p === undefined) throw new CursorMessageError('missingPart', { part: index });
  if (p.length < minimum) throw new CursorMessageError('malformedPart', { part: index });
  return p;
}

function int16(parts: Uint8Array[], index: number): number {
  const p = part(parts, index, 2);
  return ((p[0]! | (p[1]! << 8)) << 16) >> 16;
}

function int32(parts: Uint8Array[], index: number): number {
  const p = part(parts, index, 4);
  return p[0]! | (p[1]! << 8) | (p[2]! << 16) | (p[3]! << 24);
}

export interface CursorDecodeOptions {
  /** Peers at least 6.0.0 compress shapes: `[4][hash][expectedLen][zstd]`. Older send `[4][hash][CUR]`. Default true. */
  modern?: boolean;
  maximumBytes?: number;
}

/**
 * Decode one cursor command. Returns null for a command-3 selection of the
 * ignored hash (Swift returns it as a normal selection; the caller must skip it).
 */
export function decodeCursorMessage(
  parts: Uint8Array[],
  zstd: CursorZstd,
  options: CursorDecodeOptions = {},
): CursorEvent | null {
  const modern = options.modern ?? true;
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  if (!(maximumBytes > 0)) throw new CursorMessageError('sizeLimitExceeded');
  let total = 0;
  for (const p of parts) {
    if (p.length > maximumBytes - total) throw new CursorMessageError('sizeLimitExceeded');
    total += p.length;
  }
  const command = parts[0]?.[0];
  if (command === undefined) throw new CursorMessageError('missingPart', { part: 0 });
  switch (command) {
    case 3: {
      const hash = int32(parts, 1);
      return hash === IGNORED_SELECTION_HASH ? null : { type: 'select', hash };
    }
    case 4: {
      const hash = int32(parts, 1);
      let data: Uint8Array;
      if (modern) {
        const expected = int32(parts, 2);
        if (expected <= 0 || expected > maximumBytes) throw new CursorMessageError('sizeLimitExceeded');
        data = zstd(part(parts, 3, 1), expected);
        if (data.length !== expected) {
          throw new CursorMessageError('decompressedLengthMismatch', { expected, received: data.length });
        }
      } else {
        data = part(parts, 2, 1);
      }
      decodeCursorFile(data, maximumBytes);
      return { type: 'shape', hash, cur: data };
    }
    case 28:
      return { type: 'position', x: int16(parts, 1), y: int16(parts, 2) };
    default:
      throw new CursorMessageError('unsupportedCommand', { command });
  }
}

/**
 * Cursor-shape zstd for the page: one decoder created WITHOUT a dictionary
 * (UVC ordinal50 has no dictionary argument), reset before every call so a
 * failed stream never poisons the next. Never share it with the screen decoder.
 */
export async function makeCursorZstd(maximumBytes = DEFAULT_MAXIMUM_BYTES): Promise<CursorZstd> {
  const decoder = await ZstdScreenDecoder.create(null, maximumBytes);
  return (bytes) => {
    decoder.reset();
    const data = decoder.append(bytes);
    decoder.finish();
    return data;
  };
}

/** Native cache-miss request: decimal ASCII (signed hash), formatFlag=false. */
export function cursorShapeRequest(hash: number): Uint8Array {
  if (!Number.isInteger(hash) || hash < -0x80000000 || hash > 0x7fffffff) throw new RangeError('hash must be a signed 32-bit integer');
  return new TextEncoder().encode(`4|||${hash}`);
}
