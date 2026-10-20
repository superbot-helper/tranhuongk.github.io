// Port of UltraViewerProtocol/MultipartPayload.swift.
// Each part is UInt32 little-endian length followed by those bytes. No count,
// no encryption, no outer framing of its own.

const INT32_MAX = 0x7fffffff;

export type MultipartPayloadCode =
  | 'emptyPayload'
  | 'payloadTooLarge'
  | 'partTooLarge'
  | 'tooManyParts'
  | 'invalidLength'
  | 'truncatedLength'
  | 'truncatedPart';

export class MultipartPayloadError extends Error {
  readonly code: MultipartPayloadCode;
  constructor(code: MultipartPayloadCode) {
    super(code);
    this.name = 'MultipartPayloadError';
    this.code = code;
  }
}

/** Local resource limits, not negotiated UltraViewer values. */
export interface MultipartLimits {
  maximumPayloadLength?: number;
  maximumPartLength?: number;
  maximumPartCount?: number;
}

interface ResolvedLimits {
  payload: number;
  part: number;
  count: number;
}

function resolve(limits: MultipartLimits): ResolvedLimits {
  const payload = limits.maximumPayloadLength ?? 16 * 1024 * 1024;
  const part = limits.maximumPartLength ?? 16 * 1024 * 1024;
  const count = limits.maximumPartCount ?? 4096;
  if (!Number.isInteger(payload) || payload < 4 || payload > INT32_MAX) throw new RangeError('maximumPayloadLength out of range');
  if (!Number.isInteger(part) || part < 0 || part > INT32_MAX) throw new RangeError('maximumPartLength out of range');
  if (!Number.isInteger(count) || count <= 0) throw new RangeError('maximumPartCount out of range');
  return { payload, part, count };
}

export function encodeMultipart(parts: Uint8Array[], limits: MultipartLimits = {}): Uint8Array {
  const lim = resolve(limits);
  if (parts.length === 0) throw new MultipartPayloadError('emptyPayload');
  if (parts.length > lim.count) throw new MultipartPayloadError('tooManyParts');
  let total = 0;
  for (const part of parts) {
    if (part.length > lim.part) throw new MultipartPayloadError('partTooLarge');
    const next = total + 4 + part.length;
    if (next > lim.payload) throw new MultipartPayloadError('payloadTooLarge');
    total = next;
  }
  const result = new Uint8Array(total);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, true);
    result.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return result;
}

/**
 * Decodes a complete application payload. Truncated records are errors since
 * transport framing has already established the payload boundary. An empty
 * payload is rejected (local policy); empty individual parts are valid.
 */
export function decodeMultipart(payload: Uint8Array, limits: MultipartLimits = {}): Uint8Array[] {
  const lim = resolve(limits);
  if (payload.length === 0) throw new MultipartPayloadError('emptyPayload');
  if (payload.length > lim.payload) throw new MultipartPayloadError('payloadTooLarge');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  while (cursor < payload.length) {
    if (parts.length >= lim.count) throw new MultipartPayloadError('tooManyParts');
    if (payload.length - cursor < 4) throw new MultipartPayloadError('truncatedLength');
    const length = view.getUint32(cursor, true);
    cursor += 4;
    // The Windows reader uses an overflow-checked UInt32-to-Int32 cast.
    if (length > INT32_MAX) throw new MultipartPayloadError('invalidLength');
    if (length > lim.part) throw new MultipartPayloadError('partTooLarge');
    if (length > payload.length - cursor) throw new MultipartPayloadError('truncatedPart');
    parts.push(payload.slice(cursor, cursor + length));
    cursor += length;
  }
  return parts;
}
