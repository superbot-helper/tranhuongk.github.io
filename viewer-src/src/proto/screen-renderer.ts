// Port of UltraViewerProtocol/ModernScreenRenderer.swift.
// Implements the recovered >=6.0.0 desktop pipeline using the 16bpp temporary
// converter mode (DisplayColors != 1). Initialization and image decoding do not
// establish a remote session.
//
// Web-port notes:
// - The main bitmap is top-down RGBA (ImageData order) instead of BGRA.
// - apply() is async (JPEG atlas decoding) and calls are serialized in call order.
// - Atomicity: Swift copies the whole state and swaps it in on success. Here every
//   check that can fail runs first, in the Swift order, and only then is the
//   state written by a synchronous pass that cannot fail (no per-frame copy of
//   the screen buffers).
// - apply() returns the renderer's live bitmap: valid until the next apply, no
//   per-frame copy. Use snapshot() to keep a frame.
import { ZstdScreenDecoder } from '../codec/zstd-decoder';
import { ScreenRectangleBuffer, expandRGB555, opaqueBlack, packRGB555 } from './pixels';
import {
  ModernScreenMessageError,
  checkAtlasGeometry,
  checkGeometry,
  checkParts,
  screenLimits,
  validateLimits,
} from './screen-message';
import type { ModernScreenFrameMessage, ModernScreenLimits, ScreenCacheAddition, ScreenRegion } from './screen-message';

/** A rendered frame, ready for `new ImageData(rgba, width, height)`. */
export interface ScreenBitmap {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

/** Top-down RGBA pixels of a decoded JPEG. */
export interface DecodedJpeg {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}

export type JpegDecoder = (bytes: Uint8Array) => Promise<DecodedJpeg>;

export interface ModernScreenRendererOptions {
  width: number;
  height: number;
  tileSize?: number;
  /** 1 needs the custom palette and is rejected (unsupportedColorMode). */
  displayColors: number;
  /** The desktop requires incoming == previous + 1; supply the actual baseline. */
  lastFrameNumber: number;
  /** The verified 8bit.dat bytes (loadScreenDictionary). */
  dictionary?: Uint8Array | null;
  limits?: Partial<ModernScreenLimits>;
  /** Defaults to decodeJpegWithBrowser (createImageBitmap + canvas). */
  decodeJpeg?: JpegDecoder;
}

interface CachedRectangle {
  width: number;
  height: number;
  /** Tightly packed top-down RGB555, little endian. */
  pixels: Uint8Array;
}

interface AuxiliaryAtlas {
  width: number;
  height: number;
  /** Top-down RGBA; physical native rows are addressed in reverse. */
  rgba: Uint8Array | Uint8ClampedArray;
}

interface CopyWindow {
  sourceX: number;
  sourceY: number;
  destinationX: number;
  destinationY: number;
  width: number;
  height: number;
}

/** Native maximum of the ordered tile cache. */
const CACHE_ENTRY_LIMIT = 1000;

export class ModernScreenRenderer {
  /**
   * Form1.ResetLastMsgNumber, VA 0x6eb050: push 0x80000001 at 0x6eb08b, then the
   * LastMsgNumber setter 0x7bc at 0x6eb091. OnConnected and inbound command 26
   * invoke this reset. Initialization stays explicit so callers cannot silently
   * reset an active stream.
   */
  static readonly resetFrameNumber = -2_147_483_647;

  readonly width: number;
  readonly height: number;
  readonly limits: Readonly<ModernScreenLimits>;
  private currentTileSize: number;
  private currentFrameNumber: number;
  /** Top-down opaque RGBA, separate from the converter buffer. */
  private readonly main: Uint8ClampedArray;
  /** Bottom-up RGB555 with DWORD row stride. */
  private readonly temporary: ScreenRectangleBuffer;
  /** Insertion order is the native cache order (oldest first); a hit moves an entry to the end. */
  private readonly cache = new Map<number, CachedRectangle>();
  private cacheBytes = 0;
  private readonly decompressor: ZstdScreenDecoder;
  private readonly decodeJpeg: JpegDecoder;
  private readonly live: ScreenBitmap;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    o: ModernScreenRendererOptions,
    limits: ModernScreenLimits,
    tileSize: number,
    stride: number,
    decompressor: ZstdScreenDecoder,
  ) {
    this.width = o.width;
    this.height = o.height;
    this.limits = Object.freeze(limits);
    this.currentTileSize = tileSize;
    this.currentFrameNumber = o.lastFrameNumber;
    this.main = opaqueBlack(o.width, o.height);
    this.temporary = new ScreenRectangleBuffer(o.width, o.height, 2, stride, new Uint8Array(stride * o.height));
    this.decompressor = decompressor;
    this.decodeJpeg = o.decodeJpeg ?? decodeJpegWithBrowser;
    this.live = Object.freeze({ width: o.width, height: o.height, rgba: this.main });
  }

  static async create(o: ModernScreenRendererOptions): Promise<ModernScreenRenderer> {
    const limits = screenLimits(o.limits);
    validateLimits(limits);
    checkGeometry(limits, o.width, o.height);
    if (o.displayColors === 1) throw new ModernScreenMessageError('unsupportedColorMode');
    const tileSize = o.tileSize ?? 16;
    if (!Number.isInteger(tileSize) || tileSize < 1 || tileSize > 255) {
      throw new ModernScreenMessageError('invalidGeometry');
    }
    if (!Number.isInteger(o.lastFrameNumber) || o.lastFrameNumber < -0x8000_0000 || o.lastFrameNumber > 0x7fff_ffff) {
      throw new RangeError('lastFrameNumber must be an Int32');
    }
    const stride = (o.width * 2 + 3) & ~3;
    const decompressor = await ZstdScreenDecoder.create(o.dictionary ?? null, limits.maximumDecompressedBytes);
    return new ModernScreenRenderer(o, limits, tileSize, stride, decompressor);
  }

  get tileSize(): number {
    return this.currentTileSize;
  }

  get lastFrameNumber(): number {
    return this.currentFrameNumber;
  }

  /** The live bitmap (same object and buffer for the renderer's lifetime). */
  get bitmap(): ScreenBitmap {
    return this.live;
  }

  /** An independent copy of the current frame (Swift ModernScreenBitmap value semantics). */
  snapshot(): ScreenBitmap {
    return { width: this.width, height: this.height, rgba: this.main.slice() };
  }

  get cacheEntryCount(): number {
    return this.cache.size;
  }

  get cacheByteCount(): number {
    return this.cacheBytes;
  }

  /** Command 48 carries the new tile size in the first byte of part 1. */
  setTileSize(parts: Uint8Array[]): void {
    checkParts(this.limits, parts);
    const command = parts[0]?.[0];
    if (command === undefined) throw new ModernScreenMessageError('malformedPart', { part: 0 });
    if (command !== 48) throw new ModernScreenMessageError('unsupportedCommand', { command });
    const part = parts[1];
    if (part === undefined) throw new ModernScreenMessageError('missingPart', { part: 1 });
    const value = part[0];
    if (value === undefined || value === 0) throw new ModernScreenMessageError('malformedPart', { part: 1 });
    this.currentTileSize = value;
  }

  /**
   * The original clears its ordered cache on color-change/clear missions. Session
   * code must call this when changing converter mode or resetting it.
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  /** Frees the wasm-side zstd stream. */
  dispose(): void {
    this.decompressor.dispose();
  }

  /**
   * Atomic local application: malformed/unsupported frames leave the bitmap,
   * converter pixels, sequence and cache unchanged. Native code often catches and
   * continues on corrupt input; this implementation rejects it explicitly.
   */
  apply(message: ModernScreenFrameMessage): Promise<ScreenBitmap> {
    const run = this.queue.then(() => this.applyNow(message));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyNow(message: ModernScreenFrameMessage): Promise<ScreenBitmap> {
    const expected = this.currentFrameNumber + 1;
    if (message.frameNumber !== expected) {
      throw new ModernScreenMessageError('sequenceMismatch', { expected, received: message.frameNumber });
    }
    const rawPixels = this.decodeMainPixels(message);
    this.checkReferences(message);
    let atlas: AuxiliaryAtlas | null = null;
    if (message.auxiliaryRectangles.length > 0) {
      atlas = await this.decodeAuxiliaryJPEG(message.auxiliaryJPEG);
      // clearCache() may have run while the JPEG decoded.
      this.checkReferences(message);
      this.walkAuxiliary(atlas, message.auxiliaryRectangles, false);
    }
    this.checkCacheAdditions(message.cacheAdditions);

    // Nothing below can fail: commit in the native order.
    // 0x06000c65 IL_01c9..032c: capture main→converter, then converter→main.
    if (message.scroll) {
      const { capture, verticalDelta, copyBack } = message.scroll;
      this.copyMainToTemporary(capture, capture.x, capture.y - verticalDelta);
      for (const region of copyBack) this.copyTemporaryToMain(region.x, region.y, region);
    }
    // IL_032c..0443: cache references write the converter, not the main DIB.
    for (const reference of message.cacheReferences) {
      const item = this.cache.get(reference.hash) as CachedRectangle;
      this.temporary.copyRectangle(item.pixels, item.width, item.height, reference.x, reference.y);
      this.cache.delete(reference.hash);
      this.cache.set(reference.hash, item);
    }
    // IL_0443..0512: expose selected converter rectangles to the main DIB.
    for (const region of message.copyFromTemporary) this.copyTemporaryToMain(region.x, region.y, region);
    // IL_0512..0886: JPEG atlas tiles write full color directly to main.
    if (atlas) this.walkAuxiliary(atlas, message.auxiliaryRectangles, true);
    // IL_0995..0d8a: each packed raw rectangle stages at converter (0,0).
    let offset = 0;
    for (const rectangle of message.mainRectangles) {
      const count = rectangle.width * rectangle.height * 2;
      this.temporary.copyRectangle(rawPixels.subarray(offset, offset + count), rectangle.width, rectangle.height, 0, 0);
      this.copyTemporaryToMain(0, 0, rectangle);
      offset += count;
    }
    // IL_0d8a..0f3d: cache captures occur after every drawing operation.
    for (const addition of message.cacheAdditions) {
      const region = addition.region;
      this.copyMainToTemporary(region, region.x, region.y);
      if (!this.cache.has(addition.hash)) {
        const pixels = this.extractTemporary(region);
        this.cache.set(addition.hash, { width: region.width, height: region.height, pixels });
        this.cacheBytes += pixels.length;
      }
    }
    // Preserve native trim timing and insertion/reference order.
    for (const [hash, item] of this.cache) {
      if (this.cache.size <= CACHE_ENTRY_LIMIT) break;
      this.cache.delete(hash);
      this.cacheBytes -= item.pixels.length;
    }
    this.currentFrameNumber = message.frameNumber;
    return this.live;
  }

  private decodeMainPixels(message: ModernScreenFrameMessage): Uint8Array {
    let expected = 0;
    for (const region of message.mainRectangles) {
      checkGeometry(this.limits, region.width, region.height);
      const count = region.width * region.height * 2;
      if (count > this.limits.maximumDecompressedBytes - expected) {
        throw new ModernScreenMessageError('sizeLimitExceeded');
      }
      expected += count;
    }
    this.decompressor.reset(); // UVC #25 before #16, for every drawing mission.
    const decoded = this.decompressor.append(message.compressedPixels);
    this.decompressor.finish();
    if (decoded.length !== expected) {
      throw new ModernScreenMessageError('decompressedLengthMismatch', { expected, received: decoded.length });
    }
    return decoded;
  }

  private checkReferences(message: ModernScreenFrameMessage): void {
    for (const reference of message.cacheReferences) {
      if (!this.cache.has(reference.hash)) throw new ModernScreenMessageError('cacheMiss', { hash: reference.hash });
    }
  }

  /** Mirrors the commit loop: geometry, then the budget for hashes not cached yet. */
  private checkCacheAdditions(additions: ScreenCacheAddition[]): void {
    let bytes = this.cacheBytes;
    const added = new Set<number>();
    for (const addition of additions) {
      const region = addition.region;
      // Ordinal 15's out-of-bounds extraction is not established. Do not emulate
      // unsafe reads or manufacture missing cache pixels.
      if (!this.isInside(region)) throw new ModernScreenMessageError('invalidGeometry');
      if (!this.cache.has(addition.hash) && !added.has(addition.hash)) {
        const size = region.width * region.height * 2;
        if (size > this.limits.maximumCacheBytes - bytes) throw new ModernScreenMessageError('cacheBudgetExceeded');
        bytes += size;
        added.add(addition.hash);
      }
    }
  }

  /** Clips source and destination together, preserving their coordinate offset. */
  private clippedCopy(
    sourceX: number,
    sourceY: number,
    destinationX: number,
    destinationY: number,
    requestedWidth: number,
    requestedHeight: number,
  ): CopyWindow | null {
    const left = Math.max(0, -sourceX, -destinationX);
    const top = Math.max(0, -sourceY, -destinationY);
    const right = Math.min(requestedWidth, this.width - sourceX, this.width - destinationX);
    const bottom = Math.min(requestedHeight, this.height - sourceY, this.height - destinationY);
    if (!(left < right && top < bottom)) return null;
    return {
      sourceX: sourceX + left,
      sourceY: sourceY + top,
      destinationX: destinationX + left,
      destinationY: destinationY + top,
      width: right - left,
      height: bottom - top,
    };
  }

  /** Packs main pixels straight into the (bottom-up) converter rows; the clip keeps both in bounds. */
  private copyMainToTemporary(source: ScreenRegion, destinationX: number, destinationY: number): void {
    const copy = this.clippedCopy(source.x, source.y, destinationX, destinationY, source.width, source.height);
    if (!copy) return;
    const stride = this.temporary.rowStride;
    packRGB555(
      this.main,
      (copy.sourceY * this.width + copy.sourceX) * 4,
      this.width * 4,
      this.temporary.pixels,
      (this.height - 1 - copy.destinationY) * stride + copy.destinationX * 2,
      -stride,
      copy.width,
      copy.height,
    );
  }

  private copyTemporaryToMain(sourceX: number, sourceY: number, destination: ScreenRegion): void {
    const copy = this.clippedCopy(sourceX, sourceY, destination.x, destination.y, destination.width, destination.height);
    if (!copy) return;
    const stride = this.temporary.rowStride;
    expandRGB555(
      this.temporary.pixels,
      (this.height - 1 - copy.sourceY) * stride + copy.sourceX * 2,
      -stride,
      this.main,
      (copy.destinationY * this.width + copy.destinationX) * 4,
      this.width * 4,
      copy.width,
      copy.height,
    );
  }

  private extractTemporary(region: ScreenRegion): Uint8Array {
    const rowBytes = region.width * 2;
    const stride = this.temporary.rowStride;
    const result = new Uint8Array(rowBytes * region.height);
    for (let row = 0; row < region.height; row++) {
      const start = (this.height - 1 - region.y - row) * stride + region.x * 2;
      result.set(this.temporary.pixels.subarray(start, start + rowBytes), row * rowBytes);
    }
    return result;
  }

  private async decodeAuxiliaryJPEG(jpeg: Uint8Array): Promise<AuxiliaryAtlas> {
    if (jpeg.length > this.limits.maximumPayloadBytes) throw new ModernScreenMessageError('invalidJPEG');
    const header = readJpegDimensions(jpeg);
    if (!header) throw new ModernScreenMessageError('invalidJPEG');
    checkAtlasGeometry(this.limits, header.width, header.height);
    let decoded: DecodedJpeg;
    try {
      decoded = await this.decodeJpeg(jpeg);
    } catch (e) {
      if (e instanceof ModernScreenMessageError) throw e;
      throw new ModernScreenMessageError('invalidJPEG');
    }
    if (
      decoded.width !== header.width ||
      decoded.height !== header.height ||
      decoded.rgba.length !== header.width * header.height * 4
    ) {
      throw new ModernScreenMessageError('invalidJPEG');
    }
    return { width: header.width, height: header.height, rgba: decoded.rgba };
  }

  /**
   * Recovered atlas walk. With write == false it only validates (the same
   * deterministic walk), so a failing frame writes nothing.
   */
  private walkAuxiliary(atlas: AuxiliaryAtlas, rectangles: ScreenRegion[], write: boolean): void {
    const tileSize = this.currentTileSize;
    let sourceColumn = 0;
    let sourceY = 0;
    let tileCount = 0;
    for (const rectangle of rectangles) {
      if (!this.isInside(rectangle)) throw new ModernScreenMessageError('invalidGeometry');
      // Recovered loop order: destination x outside, destination y inside.
      for (let dx = 0; dx < rectangle.width; dx += tileSize) {
        for (let dy = 0; dy < rectangle.height; dy += tileSize) {
          if (tileCount >= this.limits.maximumAuxiliaryTiles) throw new ModernScreenMessageError('sizeLimitExceeded');
          tileCount++;
          const tileWidth = Math.min(tileSize, rectangle.width - dx);
          const tileHeight = Math.min(tileSize, rectangle.height - dy);
          if (sourceY + tileHeight > atlas.height) {
            sourceY = 0;
            sourceColumn++;
          }
          const sourceX = sourceColumn * tileSize;
          if (
            !(tileWidth <= atlas.width && tileHeight <= atlas.height &&
              sourceX <= atlas.width - tileWidth && sourceY <= atlas.height - tileHeight)
          ) {
            throw new ModernScreenMessageError('auxiliaryAtlasOutOfBounds');
          }
          if (write) {
            for (let row = 0; row < tileHeight; row++) {
              // Native TurboJPEG flags1026 output is bottom-up; reversing the row
              // address preserves that order without flipping the whole atlas.
              const sourceOffset = ((atlas.height - 1 - sourceY - row) * atlas.width + sourceX) * 4;
              const destination = ((rectangle.y + dy + row) * this.width + rectangle.x + dx) * 4;
              this.main.set(atlas.rgba.subarray(sourceOffset, sourceOffset + tileWidth * 4), destination);
            }
          }
          sourceY += tileHeight;
        }
      }
    }
  }

  private isInside(region: ScreenRegion): boolean {
    return (
      region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 &&
      region.width <= this.width && region.height <= this.height &&
      region.x <= this.width - region.width && region.y <= this.height - region.height
    );
  }
}

/**
 * Width/height from the first SOF segment of a baseline/progressive JPEG, or
 * null when the bytes are not a JPEG (Swift: CGImageSource type and properties
 * checks before decoding).
 */
export function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let p = 2;
  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xff) return null;
    let marker = bytes[p + 1] as number;
    p += 2;
    while (marker === 0xff && p < bytes.length) marker = bytes[p++] as number; // fill bytes
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null; // EOI/SOS before any SOF
    if (p + 2 > bytes.length) return null;
    const length = ((bytes[p] as number) << 8) | (bytes[p + 1] as number);
    if (length < 2 || p + length > bytes.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7) return null;
      return {
        height: ((bytes[p + 3] as number) << 8) | (bytes[p + 4] as number),
        width: ((bytes[p + 5] as number) << 8) | (bytes[p + 6] as number),
      };
    }
    p += length;
  }
  return null;
}

type Context2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function canvasContext(width: number, height: number): Context2D | null {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas.getContext('2d', { willReadFrequently: true });
  }
  return null;
}

/** Browser JPEG decoding: createImageBitmap, drawn 1:1 onto a canvas, read back as RGBA. */
export const decodeJpegWithBrowser: JpegDecoder = async (bytes) => {
  if (typeof createImageBitmap !== 'function') throw new ModernScreenMessageError('unsupportedJPEG');
  const image = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    const context = canvasContext(image.width, image.height);
    if (!context) throw new ModernScreenMessageError('unsupportedJPEG');
    context.globalCompositeOperation = 'copy';
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    return { width: image.width, height: image.height, rgba: pixels };
  } finally {
    image.close();
  }
};
