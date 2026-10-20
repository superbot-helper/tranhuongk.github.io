// Port of the CUR/DIB decoding in MacViewer RemoteCursorPresenter.swift: validate the CUR
// directory entry, then decode the single image resource. Swift hands PNG and the odd bitmap
// to ImageIO and decodes the common uncompressed DIB forms (1/4/8/16/24/32 bpp, optional
// palette, AND mask) itself; the browser has no ImageIO, so DIB is decoded here and PNG goes
// through an injected async decoder (createImageBitmap by default). Everything throws
// CurDecodeError where Swift returns nil; the caller shows the fallback arrow.
import { decodeCursorFile, type CursorFile } from '../proto/cursor';

export type CurDecodeErrorCode =
  | 'unsafeGeometry'
  | 'unsupportedFormat'
  | 'malformedDIB'
  | 'pngRequiresDecoder'
  | 'pngDecodeFailed';

export class CurDecodeError extends Error {
  readonly code: CurDecodeErrorCode;
  constructor(code: CurDecodeErrorCode) {
    super(code);
    this.name = 'CurDecodeError';
    this.code = code;
  }
}

export interface DecodedCursor {
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  /** Straight (non-premultiplied) RGBA, row 0 on top. */
  rgba: Uint8ClampedArray;
}

/** Decodes a PNG to straight RGBA. */
export type PngDecoder = (png: Uint8Array) => Promise<{ width: number; height: number; rgba: Uint8ClampedArray }>;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function isPng(data: Uint8Array): boolean {
  return data.length >= 8 && PNG_SIGNATURE.every((b, i) => data[i] === b);
}

function word(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function long(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function bigLong(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

const int32 = (v: number) => v | 0;

/**
 * Checks the underlying resource's own dimensions before trusting the (possibly smaller)
 * directory entry. Compressed (JPEG/RLE) DIBs are unsupported; raw DIB and bitfield forms have
 * bounded pixel dimensions.
 */
function resourceGeometryIsSafe(resource: Uint8Array, width: number, height: number): boolean {
  if (isPng(resource)) {
    // Signature, then the IHDR chunk: length(4) "IHDR" width(4) height(4).
    if (resource.length < 24 || long(resource, 12) !== 0x52444849) return false;
    const w = bigLong(resource, 16);
    const h = bigLong(resource, 20);
    return w >= 1 && w <= 256 && h >= 1 && h <= 256 && w === width && h === height;
  }
  if (resource.length < 12) return false;
  const headerSize = long(resource, 0);
  if (headerSize === 12) {
    return word(resource, 4) === width && word(resource, 6) === height * 2 && word(resource, 8) === 1 && [1, 4, 8, 24].includes(word(resource, 10));
  }
  if (headerSize < 40 || headerSize > resource.length || resource.length < 40) return false;
  const doubledHeight = int32(long(resource, 8));
  return (
    int32(long(resource, 4)) === width &&
    (doubledHeight === height * 2 || doubledHeight === -height * 2) &&
    word(resource, 12) === 1 &&
    [1, 4, 8, 16, 24, 32].includes(word(resource, 14)) &&
    [0, 3, 6].includes(long(resource, 16))
  );
}

/**
 * Packed CUR DIB: header, optional BGR(A) palette, DWORD-padded XOR rows, then DWORD-padded
 * 1bpp AND rows. The directory height is half the DIB height.
 */
function decodeUncompressedDIB(bytes: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const header = long(bytes, 0);
  if (![12, 40, 52, 56, 108, 124].includes(header) || header > bytes.length) throw new CurDecodeError('malformedDIB');
  const core = header === 12;
  const bits = word(bytes, core ? 10 : 14);
  if (![1, 4, 8, 16, 24, 32].includes(bits) || (!core && long(bytes, 16) !== 0)) throw new CurDecodeError('unsupportedFormat');
  const topDown = !core && int32(long(bytes, 8)) < 0;
  const declaredColors = core ? 0 : long(bytes, 32);
  let colorCount: number;
  if (bits <= 8) {
    colorCount = declaredColors === 0 ? 1 << bits : declaredColors;
    if (colorCount <= 0 || colorCount > 1 << bits) throw new CurDecodeError('malformedDIB');
  } else {
    // High-colour DIBs can carry an optional optimisation palette.
    if (declaredColors > 256) throw new CurDecodeError('malformedDIB');
    colorCount = declaredColors;
  }
  const paletteStride = core ? 3 : 4;
  const pixelsOffset = header + colorCount * paletteStride;
  const stride = Math.floor((width * bits + 31) / 32) * 4;
  const maskStride = Math.floor((width + 31) / 32) * 4;
  const maskOffset = pixelsOffset + stride * height;
  if (pixelsOffset > bytes.length || maskOffset > bytes.length || maskStride * height > bytes.length - maskOffset) {
    throw new CurDecodeError('malformedDIB');
  }

  // Windows reads an all-zero 32bpp alpha channel as legacy 0RGB + AND/XOR masks; any alpha
  // makes the alpha authoritative and the AND mask ignored.
  let usesAlpha = false;
  if (bits === 32) {
    for (let row = 0; row < height && !usesAlpha; row++) {
      for (let x = 0; x < width; x++) {
        if (bytes[pixelsOffset + row * stride + x * 4 + 3] !== 0) {
          usesAlpha = true;
          break;
        }
      }
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = topDown ? y : height - 1 - y;
    const row = pixelsOffset + sourceY * stride;
    const maskRow = maskOffset + sourceY * maskStride;
    for (let x = 0; x < width; x++) {
      let blue: number;
      let green: number;
      let red: number;
      let alpha = 255;
      if (bits === 1 || bits === 4 || bits === 8) {
        let index: number;
        if (bits === 1) index = (bytes[row + (x >> 3)]! >> (7 - (x % 8))) & 1;
        else if (bits === 4) index = (bytes[row + (x >> 1)]! >> (x % 2 === 0 ? 4 : 0)) & 15;
        else index = bytes[row + x]!;
        if (index >= colorCount) throw new CurDecodeError('malformedDIB');
        const entry = header + index * paletteStride;
        blue = bytes[entry]!;
        green = bytes[entry + 1]!;
        red = bytes[entry + 2]!;
      } else if (bits === 16) {
        const value = word(bytes, row + x * 2);
        const expand = (v: number) => ((v << 3) | (v >> 2)) & 0xff;
        blue = expand(value & 31);
        green = expand((value >> 5) & 31);
        red = expand((value >> 10) & 31);
      } else {
        const offset = row + x * (bits / 8);
        blue = bytes[offset]!;
        green = bytes[offset + 1]!;
        red = bytes[offset + 2]!;
        if (usesAlpha) alpha = bytes[offset + 3]!;
      }
      if (!usesAlpha && (bytes[maskRow + (x >> 3)]! & (0x80 >> (x % 8))) !== 0) {
        // AND=1: XOR black leaves the desktop (transparent). XOR!=0 inverts it (e.g. an I-beam);
        // a static sprite cannot, so it is approximated as opaque black. This intentionally
        // deviates from Swift, which rejects the cursor and shows the arrow.
        const inverted = blue !== 0 || green !== 0 || red !== 0;
        if (inverted) {
          blue = 0;
          green = 0;
          red = 0;
        } else {
          alpha = 0;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = alpha === 0 ? 0 : red;
      out[o + 1] = alpha === 0 ? 0 : green;
      out[o + 2] = alpha === 0 ? 0 : blue;
      out[o + 3] = alpha;
    }
  }
  return out;
}

function parse(file: Uint8Array): CursorFile {
  // decodeCursorFile enforces the 2 MiB bound, 1...256 sizes and hotspot < size.
  const cursor = decodeCursorFile(file);
  if (!resourceGeometryIsSafe(cursor.resourceData, cursor.width, cursor.height)) throw new CurDecodeError('unsafeGeometry');
  return cursor;
}

function result(cursor: CursorFile, rgba: Uint8ClampedArray): DecodedCursor {
  return { width: cursor.width, height: cursor.height, hotX: cursor.hotSpotX, hotY: cursor.hotSpotY, rgba };
}

/** Whether the first image of this CUR file is a PNG resource (needs `decodeCurAsync`). */
export function curIsPng(file: Uint8Array): boolean {
  return isPng(decodeCursorFile(file).resourceData);
}

/** Synchronous decode of a CUR file with a DIB image. PNG resources throw `pngRequiresDecoder`. */
export function decodeCur(file: Uint8Array): DecodedCursor {
  const cursor = parse(file);
  if (isPng(cursor.resourceData)) throw new CurDecodeError('pngRequiresDecoder');
  return result(cursor, decodeUncompressedDIB(cursor.resourceData, cursor.width, cursor.height));
}

/** Browser PNG decoder: createImageBitmap, then read the pixels back through a canvas. */
export const browserPngDecoder: PngDecoder = async (png) => {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  try {
    const { width, height } = bitmap;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new CurDecodeError('pngDecodeFailed');
    context.drawImage(bitmap, 0, 0);
    return { width, height, rgba: context.getImageData(0, 0, width, height).data };
  } finally {
    bitmap.close();
  }
};

/** Like `decodeCur`, and PNG resources are decoded through `png` (validated against the entry size). */
export async function decodeCurAsync(file: Uint8Array, png: PngDecoder = browserPngDecoder): Promise<DecodedCursor> {
  const cursor = parse(file);
  if (!isPng(cursor.resourceData)) return result(cursor, decodeUncompressedDIB(cursor.resourceData, cursor.width, cursor.height));
  let decoded: Awaited<ReturnType<PngDecoder>>;
  try {
    decoded = await png(cursor.resourceData);
  } catch (e) {
    throw e instanceof CurDecodeError ? e : new CurDecodeError('pngDecodeFailed');
  }
  if (decoded.width !== cursor.width || decoded.height !== cursor.height || decoded.rgba.length !== cursor.width * cursor.height * 4) {
    throw new CurDecodeError('unsafeGeometry');
  }
  return result(cursor, decoded.rgba);
}
