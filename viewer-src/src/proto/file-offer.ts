// Port of UltraViewerProtocol/FileTransferOffer.swift (the viewer side only).
// The file sender can be either peer, independently of screen/control direction.
// Viewer → host uses text/raw chunks; host → viewer uses multipart fields.
import type { RemoteMessage } from './commands';
import { toWellFormed, utf16le, utf8Length } from './utf16';

export const MAX_FILE_PART_SIZE = 32_000;
/** Local bound; sizes/offsets must also be exactly representable as a Double. */
export const MAX_FILE_SIZE = 999_999_999_999_999;

export type FileOfferErrorCode = 'invalidTransferId' | 'invalidFileName' | 'invalidSize' | 'invalidOffset' | 'chunkTooLarge';

/** Raised by the viewer-side builders only; decoders return null like Swift. The message carries the code only. */
export class FileOfferError extends Error {
  readonly code: FileOfferErrorCode;
  constructor(code: FileOfferErrorCode) {
    super(code);
    this.name = 'FileOfferError';
    this.code = code;
  }
}

export type FileMessage =
  | { type: 'offer'; id: string; name: string; size: number }
  | { type: 'accept'; id: string; offset: number }
  | { type: 'chunk'; id: string; offset: number; data: Uint8Array }
  | { type: 'ack'; id: string }
  | { type: 'cancel'; id: string };

// --- identifiers, names, numbers -------------------------------------------

const ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

function validId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** Swift `identifier(_:)`: 1..64 bytes of [0-9A-Za-z_-]. */
function identifier(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > 64) return null;
  let id = '';
  for (const b of bytes) {
    const ok = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 45 || b === 95;
    if (!ok) return null;
    id += String.fromCharCode(b);
  }
  return id;
}

/** Swift `isValid` for the name: not empty, <= 1024 UTF-8 bytes, no `|||`, no control characters (< 32 or 127). */
export function validFileName(name: string): boolean {
  if (name.length === 0 || name.includes('|||') || utf8Length(toWellFormed(name)) > 1024) return false;
  for (let i = 0; i < name.length; i++) {
    const unit = name.charCodeAt(i);
    if (unit < 32 || unit === 127) return false;
  }
  return true;
}

function validSize(size: number): boolean {
  return Number.isInteger(size) && size >= 0 && size <= MAX_FILE_SIZE;
}

function validOffset(offset: number): boolean {
  return Number.isInteger(offset) && offset >= 1 && offset <= MAX_FILE_SIZE;
}

/** A fresh transfer id as the Windows viewer makes them: "3" + 19 random digits. */
export function newTransferId(): string {
  let digits = '3';
  const buffer = new Uint8Array(32);
  while (digits.length < 20) {
    crypto.getRandomValues(buffer);
    for (const b of buffer) {
      // 250 = 25 * 10: reject the top six values so every digit is uniform.
      if (b < 250 && digits.length < 20) digits += String(b % 10);
    }
  }
  return digits;
}

// --- viewer → host ---------------------------------------------------------

function text(value: string): RemoteMessage {
  return { bytes: utf16le(value), formatFlag: true };
}

function checkId(id: string): void {
  if (!validId(id)) throw new FileOfferError('invalidTransferId');
}

/** "13|||id|||name|||size", UTF-16LE, format flag true. */
export function fileOfferPayload(id: string, name: string, size: number): RemoteMessage {
  checkId(id);
  const wellFormed = toWellFormed(name);
  if (!validFileName(wellFormed)) throw new FileOfferError('invalidFileName');
  if (!validSize(size)) throw new FileOfferError('invalidSize');
  return text(`13|||${id}|||${wellFormed}|||${size}`);
}

/** "14|||id|||1": accept from offset 1 (resume is not implemented). */
export function fileAcceptPayload(id: string): RemoteMessage {
  checkId(id);
  return text(`14|||${id}|||1`);
}

/** "21|||id": one chunk received. */
export function fileAckPayload(id: string): RemoteMessage {
  checkId(id);
  return text(`21|||${id}`);
}

/** "16|||id". */
export function fileCancelPayload(id: string): RemoteMessage {
  checkId(id);
  return text(`16|||${id}`);
}

/** ASCII header `15|||id|||offset|||` followed by the raw bytes, format flag false. */
export function fileChunkPayload(id: string, offset: number, data: Uint8Array): RemoteMessage {
  checkId(id);
  if (!validOffset(offset)) throw new FileOfferError('invalidOffset');
  if (data.length > MAX_FILE_PART_SIZE) throw new FileOfferError('chunkTooLarge');
  const header = new TextEncoder().encode(`15|||${id}|||${offset}|||`);
  const bytes = new Uint8Array(header.length + data.length);
  bytes.set(header);
  bytes.set(data, header.length);
  return { bytes, formatFlag: false };
}

// --- host → viewer ---------------------------------------------------------

/** `[command]` (older peers) or `[command, 0]` (Windows Int16LE). */
function validCommand(bytes: Uint8Array, command: number): boolean {
  return (bytes.length === 1 && bytes[0] === command) || (bytes.length === 2 && bytes[0] === command && bytes[1] === 0);
}

/** Swift `integerDouble`: an exact, finite, non-negative-integer Double in [minimum, MAX_FILE_SIZE]. */
function integerDouble(bytes: Uint8Array, minimum: number): number | null {
  if (bytes.length !== 8) return null;
  const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  if (!Number.isFinite(value) || value < minimum || value > MAX_FILE_SIZE || Math.trunc(value) !== value) return null;
  return value + 0; // -0 → 0
}

/**
 * Native clsRemoteClient selects Double8 for modern file transfer and Int32LE
 * for the legacy path. Accept either exact positive representation.
 */
function chunkOffset(bytes: Uint8Array): number | null {
  if (bytes.length === 8) return integerDouble(bytes, 1);
  if (bytes.length !== 4) return null;
  const value = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
  return value >= 1 && value <= 0x7fffffff ? value : null;
}

/** Windows-1252 0x80..0x9F; null = undefined by the codepage (Foundation refuses those bytes too). */
const CP1252_C1: readonly (number | null)[] = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];

function decodeCp1252(bytes: Uint8Array): string | null {
  let out = '';
  for (const b of bytes) {
    if (b >= 0x80 && b <= 0x9f) {
      const scalar = CP1252_C1[b - 0x80];
      if (scalar === null || scalar === undefined) return null;
      out += String.fromCharCode(scalar);
    } else {
      out += String.fromCharCode(b); // ASCII and 0xA0..0xFF are identical to Latin-1.
    }
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Native Windows hosts send ANSI names: CP1252 first, UTF-8 only if that fails. */
function decodeFileName(bytes: Uint8Array): string | null {
  return decodeCp1252(bytes) ?? decodeUtf8(bytes);
}

function decodeOffer(parts: Uint8Array[]): FileMessage | null {
  if (parts.length !== 4 || !validCommand(parts[0]!, 13)) return null;
  const id = identifier(parts[1]!);
  const name = decodeFileName(parts[2]!);
  const size = integerDouble(parts[3]!, 0);
  if (id === null || name === null || size === null || !validFileName(name)) return null;
  return { type: 'offer', id, name, size };
}

function decodeChunk(parts: Uint8Array[]): FileMessage | null {
  if (parts.length !== 4 || !validCommand(parts[0]!, 15)) return null;
  const id = identifier(parts[1]!);
  const offset = chunkOffset(parts[2]!);
  if (id === null || offset === null || parts[3]!.length > MAX_FILE_PART_SIZE) return null;
  return { type: 'chunk', id, offset, data: parts[3]! };
}

/**
 * Host→viewer file messages after multipart parsing (Swift
 * `FileTransferMessage.decodeHostParts`). Anything else, or anything
 * malformed, is null.
 */
export function decodeFileMessage(parts: Uint8Array[]): FileMessage | null {
  const head = parts[0];
  const command = head?.[0];
  if (head === undefined || command === undefined || ![13, 14, 15, 16, 21].includes(command) || !validCommand(head, command)) {
    return null;
  }
  if (command === 13) return decodeOffer(parts);
  if (command === 15) return decodeChunk(parts);
  const id = parts.length >= 2 ? identifier(parts[1]!) : null;
  if (id === null) return null;
  if (command === 14) {
    const field = parts[2];
    if (parts.length !== 3 || field === undefined || field.length !== 4) return null;
    const offset = (field[0]! | (field[1]! << 8) | (field[2]! << 16) | (field[3]! << 24)) >>> 0;
    return offset === 1 ? { type: 'accept', id, offset: 1 } : null; // Resume is not implemented.
  }
  if (parts.length !== 2) return null;
  return command === 16 ? { type: 'cancel', id } : { type: 'ack', id };
}
