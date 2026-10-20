// Port of UltraViewerProtocol/ModernScreenMessage.swift.
// Recovered desktop screen command layouts for targets at least version 6.0.0.
// Accepts an already decrypted and split multipart payload (decodeMultipart), not TCP bytes.

export type ModernScreenMessageErrorCode =
  | 'unsupportedCommand'
  | 'missingPart'
  | 'malformedPart'
  | 'invalidGeometry'
  | 'sizeLimitExceeded'
  | 'unsupportedColorMode'
  | 'sequenceMismatch'
  | 'decompressedLengthMismatch'
  | 'cacheMiss'
  | 'cacheBudgetExceeded'
  | 'invalidJPEG'
  | 'unsupportedJPEG'
  | 'auxiliaryAtlasOutOfBounds';

/** Associated values of the Swift enum cases. */
export interface ModernScreenMessageErrorDetail {
  /** unsupportedCommand */
  command?: number;
  /** missingPart / malformedPart */
  part?: number;
  /** sequenceMismatch (frame numbers) / decompressedLengthMismatch (byte counts) */
  expected?: number;
  received?: number;
  /** cacheMiss */
  hash?: number;
}

const USER_MESSAGES: Record<ModernScreenMessageErrorCode, string> = {
  unsupportedCommand: 'Windows sent an unsupported screen update.',
  missingPart: 'Windows sent an incomplete screen update.',
  malformedPart: 'Windows sent an incomplete screen update.',
  invalidGeometry: 'Windows sent an invalid screen rectangle.',
  sizeLimitExceeded: 'The Windows screen update exceeds the supported size.',
  unsupportedColorMode: 'The Windows screen color mode is not supported.',
  sequenceMismatch: 'Windows screen updates arrived out of order. Reconnect to refresh the screen.',
  decompressedLengthMismatch: 'The Windows screen update has an invalid pixel count.',
  cacheMiss: 'A Windows screen update refers to a missing image tile.',
  cacheBudgetExceeded: 'The Windows screen image cache is full.',
  invalidJPEG: 'Windows sent a screen image that could not be decoded.',
  unsupportedJPEG: 'Windows sent a screen image that could not be decoded.',
  auxiliaryAtlasOutOfBounds: 'A Windows screen update contains an invalid image tile.',
};

export class ModernScreenMessageError extends Error implements ModernScreenMessageErrorDetail {
  readonly code: ModernScreenMessageErrorCode;
  readonly command?: number;
  readonly part?: number;
  readonly expected?: number;
  readonly received?: number;
  readonly hash?: number;
  constructor(code: ModernScreenMessageErrorCode, detail: ModernScreenMessageErrorDetail = {}) {
    const args = Object.entries(detail).map(([k, v]) => `${k}: ${String(v)}`);
    super(args.length ? `${code}(${args.join(', ')})` : code);
    this.name = 'ModernScreenMessageError';
    this.code = code;
    Object.assign(this, detail);
  }

  /** Swift errorDescription: text suitable for the page. */
  get userMessage(): string {
    return USER_MESSAGES[this.code];
  }
}

/** Implementation limits, not protocol constants recovered from the client. */
export interface ModernScreenLimits {
  maximumDimension: number;
  maximumPixels: number;
  maximumPayloadBytes: number;
  maximumDecompressedBytes: number;
  maximumRecordsPerPart: number;
  maximumCacheBytes: number;
  maximumAuxiliaryTiles: number;
  maximumAtlasDimension: number;
}

const DEFAULT_LIMITS: Readonly<ModernScreenLimits> = Object.freeze({
  maximumDimension: 8192,
  maximumPixels: 16 * 1024 * 1024,
  maximumPayloadBytes: 64 * 1024 * 1024,
  maximumDecompressedBytes: 128 * 1024 * 1024,
  maximumRecordsPerPart: 16_384,
  maximumCacheBytes: 64 * 1024 * 1024,
  maximumAuxiliaryTiles: 1_048_576,
  maximumAtlasDimension: 65_535,
});

/** Swift ModernScreenLimits.init with defaults; validated where used. */
export function screenLimits(overrides: Partial<ModernScreenLimits> = {}): ModernScreenLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

export function validateLimits(limits: ModernScreenLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ModernScreenMessageError('sizeLimitExceeded');
  }
}

/**
 * Atlas tiles are packed into a narrow, tall JPEG. Its dimensions are independent
 * of screen geometry; actual Windows frames can exceed 8192 rows while remaining
 * small in total pixel count.
 */
export function checkAtlasGeometry(limits: ModernScreenLimits, width: number, height: number): void {
  if (!(width > 0 && height > 0)) throw new ModernScreenMessageError('invalidGeometry');
  if (
    !(width <= limits.maximumAtlasDimension && height <= limits.maximumAtlasDimension &&
      width <= Math.floor(limits.maximumPixels / height))
  ) {
    throw new ModernScreenMessageError('sizeLimitExceeded');
  }
}

export function checkGeometry(limits: ModernScreenLimits, width: number, height: number): void {
  if (!(width > 0 && height > 0)) throw new ModernScreenMessageError('invalidGeometry');
  if (
    !(width <= limits.maximumDimension && height <= limits.maximumDimension &&
      width <= Math.floor(limits.maximumPixels / height))
  ) {
    throw new ModernScreenMessageError('sizeLimitExceeded');
  }
}

export function checkParts(limits: ModernScreenLimits, parts: Uint8Array[]): void {
  validateLimits(limits);
  let total = 0;
  for (const part of parts) {
    if (part.length > limits.maximumPayloadBytes - total) throw new ModernScreenMessageError('sizeLimitExceeded');
    total += part.length;
  }
}

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The known screen fields of command 0. Unknown init parts remain uninterpreted.
 * The version byte string is kept as bytes because the Windows ANSI code page is
 * not encoded on the wire.
 */
export interface ModernScreenInitialization {
  width: number;
  height: number;
  tileSize: number;
  targetVersionBytes: Uint8Array | null;
  monitorInformationBytes: Uint8Array | null;
  virtualLeft: number | null;
  virtualTop: number | null;
}

export function decodeInitialization(
  parts: Uint8Array[],
  limits: ModernScreenLimits = screenLimits(),
): ModernScreenInitialization {
  checkParts(limits, parts);
  command(parts, 0);
  const width = int32Part(parts, 1);
  const height = int32Part(parts, 2);
  checkGeometry(limits, width, height);
  // Native optional branches consume these slots' first values whenever present,
  // regardless of the previous screen geometry. Validate their lengths even though
  // licensing/capability/initial-display flags are not interpreted here.
  for (const index of [5, 11]) {
    if (parts.length > index && (parts[index] as Uint8Array).length === 0) {
      throw new ModernScreenMessageError('malformedPart', { part: index });
    }
  }
  if (parts.length > 6) {
    if (parts.length <= 7) throw new ModernScreenMessageError('missingPart', { part: 7 });
    if ((parts[7] as Uint8Array).length === 0) throw new ModernScreenMessageError('malformedPart', { part: 7 });
  }
  if (parts.length > 12 && (parts[12] as Uint8Array).length < 2) {
    throw new ModernScreenMessageError('malformedPart', { part: 12 });
  }
  // Part 13 is consumed only when native width/height changed; this stateless
  // decoder leaves that capability uninterpreted.
  let left: number | null = null;
  let top: number | null = null;
  if (parts.length > 8) {
    left = int32Part(parts, 9);
    top = int32Part(parts, 10);
  }
  let tileSize = 16;
  if (parts.length > 14) {
    const value = (parts[14] as Uint8Array)[0];
    if (value === undefined || value === 0) throw new ModernScreenMessageError('malformedPart', { part: 14 });
    tileSize = value;
  }
  return {
    width,
    height,
    tileSize,
    targetVersionBytes: parts.length > 6 ? (parts[6] as Uint8Array) : null,
    monitorInformationBytes: parts.length > 8 ? (parts[8] as Uint8Array) : null,
    virtualLeft: left,
    virtualTop: top,
  };
}

export interface ScreenScroll {
  verticalDelta: number;
  capture: ScreenRegion;
  copyBack: ScreenRegion[];
}

export interface ScreenCacheReference {
  x: number;
  y: number;
  hash: number;
}

export interface ScreenCacheAddition {
  region: ScreenRegion;
  hash: number;
}

export interface ModernScreenFrameMessage {
  frameNumber: number;
  mainRectangles: ScreenRegion[];
  compressedPixels: Uint8Array;
  copyFromTemporary: ScreenRegion[];
  scroll: ScreenScroll | null;
  auxiliaryJPEG: Uint8Array;
  auxiliaryRectangles: ScreenRegion[];
  cacheReferences: ScreenCacheReference[];
  cacheAdditions: ScreenCacheAddition[];
}

/**
 * At least eleven slots are consumed by the original modern branch. Part 3,
 * extra header bytes and trailing slots are ignored by that branch; they are not
 * interpreted as undocumented flags or image data here.
 */
export function decodeFrameMessage(
  parts: Uint8Array[],
  limits: ModernScreenLimits = screenLimits(),
): ModernScreenFrameMessage {
  checkParts(limits, parts);
  command(parts, 1);
  if (parts.length <= 10) throw new ModernScreenMessageError('missingPart', { part: parts.length });
  const part = (index: number) => parts[index] as Uint8Array;
  const main = regions(part(1), 1, false, limits);
  const copy = regions(part(5), 5, true, limits);
  const auxiliary = regions(part(8), 8, true, limits);
  let scroll: ScreenScroll | null = null;
  const scrollBytes = part(6);
  if (scrollBytes.length > 0) {
    if (
      scrollBytes.length < 10 ||
      (scrollBytes.length - 10) % 8 !== 0 ||
      (scrollBytes.length - 10) / 8 > limits.maximumRecordsPerPart
    ) {
      throw new ModernScreenMessageError('malformedPart', { part: 6 });
    }
    scroll = {
      verticalDelta: int16(scrollBytes, 0),
      capture: region(scrollBytes, 2, true, limits),
      copyBack: regions(scrollBytes.subarray(10), 6, true, limits),
    };
  }
  const referenceBytes = part(9);
  records(referenceBytes, 9, 8, limits);
  const references: ScreenCacheReference[] = [];
  for (let offset = 0; offset < referenceBytes.length; offset += 8) {
    references.push({
      x: int16(referenceBytes, offset),
      y: int16(referenceBytes, offset + 2),
      hash: int32(referenceBytes, offset + 4),
    });
  }
  const additionBytes = part(10);
  records(additionBytes, 10, 12, limits);
  const additions: ScreenCacheAddition[] = [];
  for (let offset = 0; offset < additionBytes.length; offset += 12) {
    additions.push({ region: region(additionBytes, offset, true, limits), hash: int32(additionBytes, offset + 8) });
  }
  return {
    frameNumber: int32Part(parts, 4),
    mainRectangles: main,
    compressedPixels: part(2),
    copyFromTemporary: copy,
    scroll,
    auxiliaryJPEG: part(7),
    auxiliaryRectangles: auxiliary,
    cacheReferences: references,
    cacheAdditions: additions,
  };
}

// ScreenPartReader

function command(parts: Uint8Array[], expected: number): void {
  const first = parts[0];
  if (first === undefined) throw new ModernScreenMessageError('missingPart', { part: 0 });
  const value = first[0];
  if (value === undefined) throw new ModernScreenMessageError('malformedPart', { part: 0 });
  if (value !== expected) throw new ModernScreenMessageError('unsupportedCommand', { command: value });
}

function int32Part(parts: Uint8Array[], index: number): number {
  const part = parts[index];
  if (part === undefined) throw new ModernScreenMessageError('missingPart', { part: index });
  // Minimum consumed length is recovered; trailing bytes are ignored by native code.
  if (part.length < 4) throw new ModernScreenMessageError('malformedPart', { part: index });
  return int32(part, 0);
}

function records(data: Uint8Array, part: number, size: number, limits: ModernScreenLimits): void {
  if (data.length % size !== 0) throw new ModernScreenMessageError('malformedPart', { part });
  if (data.length / size > limits.maximumRecordsPerPart) throw new ModernScreenMessageError('sizeLimitExceeded');
}

function regions(data: Uint8Array, part: number, signed: boolean, limits: ModernScreenLimits): ScreenRegion[] {
  records(data, part, 8, limits);
  const result: ScreenRegion[] = [];
  for (let offset = 0; offset < data.length; offset += 8) result.push(region(data, offset, signed, limits));
  return result;
}

function region(bytes: Uint8Array, offset: number, signed: boolean, limits: ModernScreenLimits): ScreenRegion {
  const read = signed ? int16 : uint16;
  const result = {
    x: read(bytes, offset),
    y: read(bytes, offset + 2),
    width: read(bytes, offset + 4),
    height: read(bytes, offset + 6),
  };
  checkGeometry(limits, result.width, result.height);
  return result;
}

function uint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

function int16(bytes: Uint8Array, offset: number): number {
  return (uint16(bytes, offset) << 16) >> 16;
}

function int32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16) |
    ((bytes[offset + 3] as number) << 24)
  );
}
