// Test-only helpers for the screen pipeline (ports of the private helpers in
// ModernScreenTests.swift / ScreenPixelStorageTests.swift). Not imported by production code.
import { decode as decodeJpegJs } from 'jpeg-js';
import type { JpegDecoder } from './screen-renderer';
import { concat, u8 } from './test-utils';

/** Little-endian UInt16 words; values are truncated like Swift's UInt16(truncatingIfNeeded:). */
export function screenWords(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  values.forEach((value, i) => {
    out[i * 2] = value & 0xff;
    out[i * 2 + 1] = (value >> 8) & 0xff;
  });
  return out;
}

/** Little-endian Int32. */
export function screenLong(value: number): Uint8Array {
  return u8(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/** Independently specified zstd single-segment frame with one final raw block (FCS 1 byte). */
export function rawScreenZstd(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 256) throw new RangeError('fixture too large');
  const blockHeader = (bytes.length << 3) | 1;
  return concat(u8(0x28, 0xb5, 0x2f, 0xfd, 0x20, bytes.length, blockHeader & 0xff, (blockHeader >> 8) & 0xff, 0), bytes);
}

export interface ScreenPartsOptions {
  sequence?: number;
  rectangles?: number[];
  pixels?: Uint8Array;
  copy?: number[];
  scroll?: number[];
  jpeg?: Uint8Array;
  auxiliary?: number[];
  references?: Uint8Array;
  additions?: Uint8Array;
}

export function screenParts(o: ScreenPartsOptions = {}): Uint8Array[] {
  const pixels = o.pixels ?? new Uint8Array();
  return [
    u8(1),
    screenWords(o.rectangles ?? []),
    pixels.length === 0 ? new Uint8Array() : rawScreenZstd(pixels),
    new Uint8Array(),
    screenLong(o.sequence ?? 1),
    screenWords(o.copy ?? []),
    screenWords(o.scroll ?? []),
    o.jpeg ?? new Uint8Array(),
    screenWords(o.auxiliary ?? []),
    o.references ?? new Uint8Array(),
    o.additions ?? new Uint8Array(),
  ];
}

export function hexData(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function base64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/** Pure-JS JPEG decoder for Vitest (no createImageBitmap/OffscreenCanvas in Node). */
export const jpegJsDecoder: JpegDecoder = async (bytes) => {
  const image = decodeJpegJs(bytes, { useTArray: true, formatAsRGBA: true });
  return { width: image.width, height: image.height, rgba: image.data };
};

/** Run `fn`, return what it threw (or fail if it did not throw). */
export function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected an error to be thrown');
}

export async function caughtAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected an error to be thrown');
}
