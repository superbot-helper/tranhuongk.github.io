import { beforeAll, describe, expect, test } from 'vitest';
import { ZstdScreenDecoder, ZstdScreenDecoderError } from '../codec/zstd-decoder';
import {
  ClipboardError,
  MAX_CLIPBOARD_PAYLOAD_BYTES,
  MAX_CLIPBOARD_TEXT_BYTES,
  type ClipboardZstd,
  clipboardPayload,
  clipboardPayloadLegacy,
  decodeClipboard,
  makeClipboardZstd,
  rawZstdFrame,
} from './clipboard';
import { concat, enc, expectError, u8 } from './test-utils';

const clipboardTextFixture = 'A🙂\r\n\t中|||B';
const clipboardUtf16Fixture = u8(
  0x41, 0, 0x3d, 0xd8, 0x42, 0xde, 0x0d, 0, 0x0a, 0, 0x09, 0,
  0x2d, 0x4e, 0x7c, 0, 0x7c, 0, 0x7c, 0, 0x42, 0,
);

// Independent UTF-16LE encoder (the production one lives in utf16.ts).
function utf16(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out.push(unit & 0xff, unit >> 8);
  }
  return u8(...out);
}

const long = (n: number): Uint8Array => u8(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);

// Independent Zstd RAW frame (single block), rather than the production code.
function clipboardRawZstdFixture(bytes: Uint8Array): Uint8Array {
  const lastRawBlock = (bytes.length << 3) | 1;
  return concat(
    u8(0x28, 0xb5, 0x2f, 0xfd, 0xa0),
    long(bytes.length),
    u8(lastRawBlock & 0xff, (lastRawBlock >> 8) & 0xff, (lastRawBlock >> 16) & 0xff),
    bytes,
  );
}

const clipboardError = (fn: () => unknown, code: string): void => expectError(fn, ClipboardError, code);

let zstd: ClipboardZstd;
beforeAll(async () => {
  zstd = await makeClipboardZstd();
});

// Ported from ClipboardProtocolTests.swift. The host-side decoders
// (decodeViewerToHost, decodeNormalizedViewerToHost) and hostToViewer are not
// part of the browser viewer: the same wire vectors are asserted by parsing
// the viewer-to-host bytes by hand and through decodeClipboard (host→viewer).
describe('clipboard protocol (ClipboardProtocolTests.swift)', () => {
  test('independent raw fixtures establish both modern envelopes and UTF-16', () => {
    expect(clipboardUtf16Fixture.length).toBe(22);
    const compressed = clipboardRawZstdFixture(clipboardUtf16Fixture);
    expect(compressed.slice(0, 12)).toEqual(u8(0x28, 0xb5, 0x2f, 0xfd, 0xa0, 22, 0, 0, 0, 0xb1, 0, 0));
    // The production frame writer equals the independent fixture byte for byte.
    expect(rawZstdFrame(clipboardUtf16Fixture)).toEqual(compressed);
    // Controller→host modern payload: ASCII header + the frame, ordinary false flag.
    const viewer = clipboardPayload(clipboardTextFixture);
    expect(viewer.formatFlag).toBe(false);
    expect(viewer.bytes).toEqual(concat(enc('33|||22|||'), compressed));
    expect(decodeClipboard([u8(33), u8(22, 0, 0, 0), compressed], zstd)).toBe(clipboardTextFixture);
    expect(decodeClipboard([u8(5), clipboardUtf16Fixture], zstd)).toBe(clipboardTextFixture);
  });

  test('native compression round-trips Unicode, delimiters and controls', () => {
    const text = clipboardTextFixture.repeat(1000);
    const viewer = clipboardPayload(text);
    expect(viewer.formatFlag).toBe(false);
    const header = enc('33|||22000|||');
    expect(viewer.bytes.slice(0, header.length)).toEqual(header);
    // Raw blocks are stored, not compressed: the frame is the UTF-16 bytes plus 12 bytes of framing.
    const frame = viewer.bytes.slice(header.length);
    expect(frame.length).toBe(22000 + 12);
    expect(zstd(frame, 22000)).toEqual(utf16(text));
    // 22000 UTF-16 bytes (0x55f0), not characters / UTF-8 bytes, as the host would announce.
    expect(long(22000)).toEqual(u8(0xf0, 0x55, 0, 0));
    expect(decodeClipboard([u8(33), long(22000), frame], zstd)).toBe(text);
  });

  test('legacy viewer has a true-flag UTF-16 prefix and an explicit delimiter limit', () => {
    const viewer = clipboardPayloadLegacy('A🙂\r\n\t中');
    expect(viewer.formatFlag).toBe(true);
    expect(viewer.bytes.slice(0, 8)).toEqual(u8(0x35, 0, 0x7c, 0, 0x7c, 0, 0x7c, 0));
    expect(viewer.bytes).toEqual(utf16('5|||A🙂\r\n\t中'));
    expect(decodeClipboard([u8(5), utf16('A🙂\r\n\t中')], zstd)).toBe('A🙂\r\n\t中');
    clipboardError(() => clipboardPayloadLegacy('left|||right'), 'unsupportedLegacyDelimiter');
    // The modern form carries arbitrary text, delimiters included.
    expect(clipboardPayload('left|||right').bytes.length).toBeGreaterThan(0);
  });

  test('rejects malformed lengths, headers and UTF-16', () => {
    const compressed = clipboardRawZstdFixture(clipboardUtf16Fixture);
    // decompressedLengthMismatch(expected: 20, received: 22), with its associated values.
    let mismatch: unknown;
    try {
      decodeClipboard([u8(33), long(20), compressed], zstd);
    } catch (e) {
      mismatch = e;
    }
    expect(mismatch).toBeInstanceOf(ClipboardError);
    expect(mismatch).toMatchObject({ code: 'decompressedLengthMismatch', expected: 20, received: 22 });
    // An odd announced byte count cannot be UTF-16 (the host's "33|||1|||" case).
    clipboardError(() => decodeClipboard([u8(33), long(1), compressed], zstd), 'invalidText');
    for (const invalid of [u8(1), u8(0, 0), u8(0, 0xd8), u8(0, 0xdc), u8(0, 0xd8, 0x41, 0)]) {
      clipboardError(() => decodeClipboard([u8(5), invalid], zstd), 'invalidText');
    }
    clipboardError(() => clipboardPayload('NUL\0text'), 'invalidText');
    clipboardError(() => decodeClipboard([u8(33), u8(2)], zstd), 'malformedMessage');
    clipboardError(() => decodeClipboard([u8(12), enc('chat')], zstd), 'unsupportedCommand');
  });

  test('bounds apply before compression and during expansion', () => {
    clipboardError(() => clipboardPayload('a'.repeat(MAX_CLIPBOARD_TEXT_BYTES / 2 + 1)), 'sizeLimitExceeded');
    // The host's "33|||1048578|||" header case: an announced length above the limit.
    clipboardError(() => decodeClipboard([u8(33), long(MAX_CLIPBOARD_TEXT_BYTES + 2), u8(1)], zstd), 'sizeLimitExceeded');
    clipboardError(
      () => decodeClipboard([u8(5), new Uint8Array(MAX_CLIPBOARD_PAYLOAD_BYTES + 1)], zstd),
      'sizeLimitExceeded',
    );
    const overExpanded = rawZstdFrame(new Uint8Array(MAX_CLIPBOARD_TEXT_BYTES + 2).fill(0x41));
    expectError(
      () => decodeClipboard([u8(33), long(2), overExpanded], zstd),
      ZstdScreenDecoderError,
      'outputLimitExceeded',
    );
  });

  test('empty text remains a valid independent message', () => {
    const viewer = clipboardPayload('');
    expect(viewer.formatFlag).toBe(true);
    expect(viewer.bytes).toEqual(utf16('5|||'));
    expect(decodeClipboard([u8(5), new Uint8Array()], zstd)).toBe('');
    // The Swift host encodes the empty modern message as announced length 0 + a valid empty frame.
    expect(decodeClipboard([u8(33), long(0), rawZstdFrame(new Uint8Array())], zstd)).toBe('');
  });
});

// Extra coverage specific to the TypeScript port.
describe('clipboard protocol (port extras)', () => {
  test('the maximum text round-trips through the modern envelope', () => {
    const text = 'x'.repeat(MAX_CLIPBOARD_TEXT_BYTES / 2);
    const viewer = clipboardPayload(text);
    const header = enc(`33|||${MAX_CLIPBOARD_TEXT_BYTES}|||`);
    expect(viewer.bytes.slice(0, header.length)).toEqual(header);
    expect(viewer.bytes.length).toBeLessThan(MAX_CLIPBOARD_PAYLOAD_BYTES);
    expect(decodeClipboard([u8(33), long(MAX_CLIPBOARD_TEXT_BYTES), viewer.bytes.slice(header.length)], zstd)).toBe(text);
  });

  test('a lone surrogate becomes U+FFFD like a Swift String would', () => {
    expect(clipboardPayloadLegacy('x\udc00').bytes).toEqual(concat(utf16('5|||x'), u8(0xfd, 0xff)));
  });

  test('malformed host messages', () => {
    const frame = rawZstdFrame(clipboardUtf16Fixture);
    clipboardError(() => decodeClipboard([], zstd), 'malformedMessage');
    clipboardError(() => decodeClipboard([new Uint8Array(), u8(1)], zstd), 'malformedMessage');
    clipboardError(() => decodeClipboard([u8(5)], zstd), 'malformedMessage');
    clipboardError(() => decodeClipboard([u8(33), u8(22, 0, 0)], zstd), 'malformedMessage');
    clipboardError(() => decodeClipboard([u8(33), long(22), new Uint8Array()], zstd), 'malformedMessage');
    clipboardError(() => decodeClipboard([u8(5), new Uint8Array(MAX_CLIPBOARD_TEXT_BYTES + 2)], zstd), 'sizeLimitExceeded');
    // A well-formed frame with garbage in the data is a decoder error, not a silent empty string.
    expect(() => decodeClipboard([u8(33), long(22), concat(frame.slice(0, 12), u8(1, 2))], zstd)).toThrow();
  });

  test('errors never include the clipboard text', () => {
    let thrown: unknown;
    try {
      clipboardPayloadLegacy('secret|||clip');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as ClipboardError).message).toBe('unsupportedLegacyDelimiter');
  });
});

describe('rawZstdFrame', () => {
  const pattern = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >> 8)) & 0xff);

  test('header and block layout', () => {
    // Zero bytes: header + one empty last raw block.
    expect(rawZstdFrame(new Uint8Array())).toEqual(u8(0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0, 0, 0, 0, 1, 0, 0));
    // 128 KiB + 1: a full non-last raw block, then a 1-byte last raw block.
    const data = pattern(131_073);
    const frame = rawZstdFrame(data);
    expect(frame.slice(0, 9)).toEqual(u8(0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0x01, 0x00, 0x02, 0x00));
    expect(frame.slice(9, 12)).toEqual(u8(0x00, 0x00, 0x10)); // raw, not last, size 131072 (<< 3)
    expect(frame.slice(12 + 131_072, 12 + 131_072 + 3)).toEqual(u8(0x09, 0, 0)); // raw, last, size 1
    expect(frame.length).toBe(9 + 3 + 131_072 + 3 + 1);
    // The 128 KiB boundary itself is a single last block.
    expect(rawZstdFrame(pattern(131_072)).length).toBe(9 + 3 + 131_072);
  });

  test.each([0, 22, 131_072, 131_073, 1_048_576])('round-trips %i bytes through the WASM decoder', async (n) => {
    const data = pattern(n);
    const decoder = await ZstdScreenDecoder.create(null, 2 * 1024 * 1024);
    try {
      const out = decoder.append(rawZstdFrame(data));
      decoder.finish();
      expect(out).toEqual(data);
    } finally {
      decoder.dispose();
    }
  });
});
