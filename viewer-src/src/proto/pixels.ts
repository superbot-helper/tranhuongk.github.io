// Ports of UltraViewerProtocol/ScreenPixelStorage.swift (pixel kernels) and
// ScreenRectangleBuffer.swift (uvc.dll ordinal 24 row copy).
//
// Web port: the full-colour side is RGBA (ImageData byte order, alpha 255)
// instead of the Swift BGRA; the RGB555 side is unchanged (little-endian words,
// bit 15 ignored). Offsets are byte offsets into the given arrays; row strides
// may be negative for bottom-up converter rows. Callers validate regions.

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** RGB555 → RGBA, one entry per 15-bit value, packed for a little-endian Uint32 store. */
const RGB555_TO_RGBA32 = (() => {
  const table = new Uint32Array(32_768);
  for (let value = 0; value < 32_768; value++) {
    const blue5 = value & 31;
    const green5 = (value >> 5) & 31;
    const red5 = (value >> 10) & 31;
    const red = (red5 << 3) | (red5 >> 2);
    const green = (green5 << 3) | (green5 >> 2);
    const blue = (blue5 << 3) | (blue5 >> 2);
    table[value] = (red | (green << 8) | (blue << 16) | 0xff00_0000) >>> 0;
  }
  return table;
})();

/** Same table as four bytes per entry, for unaligned destinations. */
const RGB555_TO_RGBA8 = new Uint8Array(RGB555_TO_RGBA32.buffer.slice(0));
if (!LITTLE_ENDIAN) {
  for (let i = 0; i < 32_768; i++) {
    const v = RGB555_TO_RGBA32[i] ?? 0;
    RGB555_TO_RGBA8[i * 4] = v & 0xff;
    RGB555_TO_RGBA8[i * 4 + 1] = (v >>> 8) & 0xff;
    RGB555_TO_RGBA8[i * 4 + 2] = (v >>> 16) & 0xff;
    RGB555_TO_RGBA8[i * 4 + 3] = v >>> 24;
  }
}

/** Expands RGB555 rows into opaque RGBA rows. */
export function expandRGB555(
  source: Uint8Array,
  sourceOffset: number,
  sourceRowBytes: number,
  destination: Uint8Array | Uint8ClampedArray,
  destinationOffset: number,
  destinationRowBytes: number,
  width: number,
  height: number,
): void {
  const absolute = destination.byteOffset + destinationOffset;
  if (LITTLE_ENDIAN && absolute % 4 === 0 && destinationRowBytes % 4 === 0) {
    // Aligned fast path: one Uint32 store per pixel.
    const out = new Uint32Array(destination.buffer, 0, Math.floor(destination.buffer.byteLength / 4));
    const rowWords = destinationRowBytes / 4;
    let outRow = absolute / 4;
    let inRow = sourceOffset;
    for (let row = 0; row < height; row++) {
      let i = inRow;
      let o = outRow;
      const end = o + width;
      while (o < end) {
        out[o++] = RGB555_TO_RGBA32[((source[i] as number) | ((source[i + 1] as number) << 8)) & 0x7fff] as number;
        i += 2;
      }
      inRow += sourceRowBytes;
      outRow += rowWords;
    }
    return;
  }
  let inRow = sourceOffset;
  let outRow = destinationOffset;
  for (let row = 0; row < height; row++) {
    let i = inRow;
    let o = outRow;
    for (let x = 0; x < width; x++) {
      const entry = (((source[i] as number) | ((source[i + 1] as number) << 8)) & 0x7fff) * 4;
      destination[o] = RGB555_TO_RGBA8[entry] as number;
      destination[o + 1] = RGB555_TO_RGBA8[entry + 1] as number;
      destination[o + 2] = RGB555_TO_RGBA8[entry + 2] as number;
      destination[o + 3] = 255;
      i += 2;
      o += 4;
    }
    inRow += sourceRowBytes;
    outRow += destinationRowBytes;
  }
}

/** Packs RGBA rows into RGB555 (top five bits per channel; bit 15 cleared). */
export function packRGB555(
  source: Uint8Array | Uint8ClampedArray,
  sourceOffset: number,
  sourceRowBytes: number,
  destination: Uint8Array,
  destinationOffset: number,
  destinationRowBytes: number,
  width: number,
  height: number,
): void {
  let inRow = sourceOffset;
  let outRow = destinationOffset;
  for (let row = 0; row < height; row++) {
    let i = inRow;
    let o = outRow;
    for (let x = 0; x < width; x++) {
      const value =
        ((source[i + 2] as number) >> 3) | (((source[i + 1] as number) >> 3) << 5) | (((source[i] as number) >> 3) << 10);
      destination[o] = value & 0xff;
      destination[o + 1] = value >> 8;
      i += 4;
      o += 2;
    }
    inRow += sourceRowBytes;
    outRow += destinationRowBytes;
  }
}

/** A width×height opaque black RGBA image. */
export function opaqueBlack(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (LITTLE_ENDIAN) new Uint32Array(pixels.buffer).fill(0xff00_0000);
  else for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  return pixels;
}

/** Compatibility/export view (Swift ModernScreenBitmap.bgrPixels): top-down, tightly packed BGR24. */
export function bgr24FromRGBA(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const count = width * height;
  const result = new Uint8Array(count * 3);
  for (let p = 0, i = 0, o = 0; p < count; p++, i += 4, o += 3) {
    result[o] = rgba[i + 2] as number;
    result[o + 1] = rgba[i + 1] as number;
    result[o + 2] = rgba[i] as number;
  }
  return result;
}

export type ScreenRectangleBufferErrorCode =
  | 'invalidGeometry'
  | 'invalidStride'
  | 'invalidDestinationLength'
  | 'truncatedSource'
  | 'sizeOverflow';

export class ScreenRectangleBufferError extends Error {
  readonly code: ScreenRectangleBufferErrorCode;
  constructor(code: ScreenRectangleBufferErrorCode) {
    super(code);
    this.name = 'ScreenRectangleBufferError';
    this.code = code;
  }
}

/** Swift Int.multipliedReportingOverflow analogue: exact results only (≤ 2^53 − 1). */
function product(lhs: number, rhs: number): number {
  const value = lhs * rhs;
  if (!Number.isSafeInteger(value)) throw new ScreenRectangleBufferError('sizeOverflow');
  return value;
}

/**
 * Raw row-copy operation recovered from uvc.dll ordinal 24 (VA 0x100016b0).
 * A drawing primitive after decompression, not a screen-message decoder. Pixel
 * channels are opaque. Destination rows are stored bottom-up, including row padding.
 * `pixels` is used in place (not copied).
 */
export class ScreenRectangleBuffer {
  readonly width: number;
  readonly height: number;
  readonly bytesPerPixel: number;
  readonly rowStride: number;
  readonly pixels: Uint8Array;

  /** Geometry/length checks are local validation policies, not recovered wire limits. */
  constructor(width: number, height: number, bytesPerPixel: number, rowStride: number, pixels: Uint8Array) {
    if (![width, height, bytesPerPixel, rowStride].every(Number.isInteger)) {
      throw new ScreenRectangleBufferError('invalidGeometry');
    }
    if (width <= 0 || height <= 0 || bytesPerPixel <= 0) throw new ScreenRectangleBufferError('invalidGeometry');
    const minimumStride = product(width, bytesPerPixel);
    if (rowStride < minimumStride) throw new ScreenRectangleBufferError('invalidStride');
    const size = product(height, rowStride);
    if (pixels.length !== size) throw new ScreenRectangleBufferError('invalidDestinationLength');
    this.width = width;
    this.height = height;
    this.bytesPerPixel = bytesPerPixel;
    this.rowStride = rowStride;
    this.pixels = pixels;
  }

  /**
   * Copies a tightly packed, top-down source rectangle at top-left coordinates.
   * Clips against destination bounds and preserves all untouched bytes/padding.
   * Additional bytes following the source rectangle are not read.
   */
  copyRectangle(source: Uint8Array, sourceWidth: number, sourceHeight: number, x: number, y: number): void {
    if (![sourceWidth, sourceHeight, x, y].every(Number.isInteger)) {
      throw new ScreenRectangleBufferError('invalidGeometry');
    }
    if (sourceWidth <= 0 || sourceHeight <= 0) throw new ScreenRectangleBufferError('invalidGeometry');
    const sourceStride = product(sourceWidth, this.bytesPerPixel);
    const requiredSourceBytes = product(sourceStride, sourceHeight);
    if (source.length < requiredSourceBytes) throw new ScreenRectangleBufferError('truncatedSource');

    // Compare before negating coordinates or adding extents.
    if (!(x < this.width && y < this.height && x > -sourceWidth && y > -sourceHeight)) return;
    const sourceX = x < 0 ? -x : 0;
    const sourceY = y < 0 ? -y : 0;
    const destinationX = Math.max(0, x);
    const destinationY = Math.max(0, y);
    const copyWidth = Math.min(sourceWidth - sourceX, this.width - destinationX);
    const copyHeight = Math.min(sourceHeight - sourceY, this.height - destinationY);
    const copyBytes = copyWidth * this.bytesPerPixel;

    for (let row = 0; row < copyHeight; row++) {
      const sourceOffset = (sourceY + row) * sourceStride + sourceX * this.bytesPerPixel;
      const destinationOffset =
        (this.height - 1 - (destinationY + row)) * this.rowStride + destinationX * this.bytesPerPixel;
      this.pixels.set(source.subarray(sourceOffset, sourceOffset + copyBytes), destinationOffset);
    }
  }
}
