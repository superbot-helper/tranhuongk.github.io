import { describe, expect, test } from 'vitest';
import { bgr24FromRGBA } from './pixels';
import { ModernScreenMessageError, decodeFrameMessage, screenLimits } from './screen-message';
import type { ModernScreenFrameMessage } from './screen-message';
import { ModernScreenRenderer } from './screen-renderer';
import type { ModernScreenRendererOptions, ScreenBitmap } from './screen-renderer';
import {
  base64,
  caught,
  caughtAsync,
  hexData,
  jpegJsDecoder,
  screenLong,
  screenParts,
  screenWords,
} from './screen-test-utils';
import { concat, u8 } from './test-utils';

const bgr = (bitmap: ScreenBitmap) => bgr24FromRGBA(bitmap.rgba, bitmap.width, bitmap.height);

function renderer(o: Partial<ModernScreenRendererOptions> & { width: number; height: number }) {
  return ModernScreenRenderer.create({ displayColors: 0, lastFrameNumber: 0, decodeJpeg: jpegJsDecoder, ...o });
}

async function screenError(promise: Promise<unknown>): Promise<ModernScreenMessageError> {
  const error = await caughtAsync(() => promise);
  expect(error).toBeInstanceOf(ModernScreenMessageError);
  return error as ModernScreenMessageError;
}

// Native UVC #44/#46/#45 fixture, not a peer capture (2×2 JPEG).
// JPEG SHA-256 e08964d8648f363ec180059893a8b907a621877308ac90b12f3ab26e58f26b23.
const screenJPEGFixture = base64(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8KP8Ahr79rP8A6Oh/aJ/8PZ8Sv/mmooor+fz6xdPl/wC4z//Z',
);

/** ScreenPixelStorageTests.swift pixelTestMessage: FHD 0xa0 (single segment, 4-byte FCS), raw last block. */
function pixelTestMessage(sequence: number, rectangles: number[], pixels: number[]): ModernScreenFrameMessage {
  const raw = screenWords(pixels);
  const block = (raw.length << 3) | 1;
  const zstd = concat(
    u8(0x28, 0xb5, 0x2f, 0xfd, 0xa0),
    screenLong(raw.length),
    u8(block & 0xff, (block >> 8) & 0xff, (block >> 16) & 0xff),
    raw,
  );
  const empty = new Uint8Array();
  return decodeFrameMessage([u8(1), screenWords(rectangles), zstd, empty, screenLong(sequence), empty, empty, empty, empty, empty, empty]);
}

// Ported from ScreenPixelStorageTests.swift (renderer tests).
describe('ModernScreenRenderer (ScreenPixelStorageTests.swift)', () => {
  test('screenBitmapSnapshotsSurviveLaterRendererWrites', async () => {
    // Web port: apply() returns the renderer's live bitmap (valid until the next
    // apply, no per-frame copy); snapshot() is the value-semantics equivalent of
    // the Swift ModernScreenBitmap and is what this test retains.
    const r = await renderer({ width: 2, height: 1, displayColors: 2 });
    const initial = r.snapshot();
    expect(bgr(initial)).toEqual(new Uint8Array(6));
    const first = await r.apply(pixelTestMessage(1, [0, 0, 2, 1], [0x7c00, 0x03e0]));
    const firstSnapshot = r.snapshot();
    const second = await r.apply(pixelTestMessage(2, [0, 0, 2, 1], [0x001f, 0x7fff]));
    expect(bgr(firstSnapshot)).toEqual(u8(0, 0, 255, 0, 255, 0));
    expect(bgr(initial)).toEqual(new Uint8Array(6));
    expect(bgr(second)).toEqual(u8(255, 0, 0, 255, 255, 255));
    // Swift CGImage provider bytes were BGRA 0,0,255,255, 0,255,0,255.
    expect(Array.from(firstSnapshot.rgba)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(first.rgba).toBe(second.rgba);
    expect(r.bitmap.rgba).toBe(second.rgba);
  });

  test('screenRawRectangleSlicesPreserveOffsetsAndConverterStaging', async () => {
    const r = await renderer({ width: 3, height: 2, displayColors: 2 });
    const message = pixelTestMessage(1, [0, 0, 2, 1, 2, 0, 1, 2], [0x7c00, 0x7c00, 0x03e0, 0x03e0]);
    expect(bgr(await r.apply(message))).toEqual(u8(0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0));
  });
});

// Ported from ModernScreenTests.swift (renderer tests).
describe('ModernScreenRenderer (ModernScreenTests.swift)', () => {
  test('displayColors == 1 is unsupportedColorMode (from modernScreenInitializationAndMalformedParts)', async () => {
    expect((await screenError(renderer({ width: 1, height: 1, displayColors: 1 }))).code).toBe('unsupportedColorMode');
  });

  test('modernRGB555ExpansionMatchesWindowsGDIFixture', async () => {
    // Exact independent Windows BitBlt fixture, all 32 blue channel values.
    const raw = hexData('00000100020003000400050006000700080009000a000b000c000d000e000f0010001100120013001400150016001700180019001a001b001c001d001e001f00');
    const expected = hexData('0000000800001000001800002100002900003100003900004200004a00005200005a00006300006b00007300007b00008400008c00009400009c0000a50000ad0000b50000bd0000c60000ce0000d60000de0000e70000ef0000f70000ff0000');
    const r = await renderer({ width: 32, height: 1 });
    const message = decodeFrameMessage(screenParts({ rectangles: [0, 0, 32, 1], pixels: raw }));
    expect(bgr(await r.apply(message))).toEqual(expected);
    expect(r.bitmap.width).toBe(32);
  });

  test('modernScreenResetBaselineAcceptsSignedFirstFrameFixture', async () => {
    // Checked desktop ResetLastMsgNumber immediate, not an inferred zero start.
    expect(ModernScreenRenderer.resetFrameNumber).toBe(0x8000_0001 | 0);
    const r = await renderer({ width: 1, height: 1, lastFrameNumber: ModernScreenRenderer.resetFrameNumber });
    const parts = screenParts({ rectangles: [0, 0, 1, 1], pixels: screenWords([0x03e0]) });
    parts[4] = u8(0x02, 0x00, 0x00, 0x80); // little-endian -2147483646
    const first = decodeFrameMessage(parts);
    expect(first.frameNumber).toBe(-2_147_483_646);
    expect(bgr(await r.apply(first))).toEqual(u8(0, 255, 0));
    expect(r.lastFrameNumber).toBe(-2_147_483_646);
    expect(await screenError(r.apply(first))).toMatchObject({
      code: 'sequenceMismatch',
      expected: -2_147_483_645,
      received: -2_147_483_646,
    });
  });

  test('modernRawRectanglesRespectPaddedTemporaryRowsAndClipping', async () => {
    const r = await renderer({ width: 3, height: 2, displayColors: 2 });
    // Converter stride is 8, while tightly packed source rows occupy 6 bytes.
    const raw = screenWords([0x7c00, 0x03e0, 0x001f, 0x7fff, 0x0000, 0x7c00]);
    const bitmap = await r.apply(decodeFrameMessage(screenParts({ rectangles: [1, 0, 3, 2], pixels: raw })));
    expect(bgr(bitmap)).toEqual(hexData('0000000000ff00ff00000000ffffff000000'));
  });

  test('modernScrollCopiesFromMainBeforeCopyBackAndClipsTogether', async () => {
    const r = await renderer({ width: 1, height: 3 });
    await r.apply(decodeFrameMessage(screenParts({ rectangles: [0, 0, 1, 3], pixels: screenWords([0x7c00, 0x03e0, 0x001f]) })));
    const scroll = decodeFrameMessage(screenParts({ sequence: 2, scroll: [1, 0, 0, 1, 3, 0, 0, 1, 2] }));
    expect(bgr(await r.apply(scroll))).toEqual(hexData('00ff00ff0000ff0000'));
  });

  test('modernJPEGUsesBottomUpAtlasAndSharedColumnMajorCursor', async () => {
    const r = await renderer({ width: 4, height: 1, tileSize: 1 });
    const message = decodeFrameMessage(screenParts({ jpeg: screenJPEGFixture, auxiliary: [0, 0, 3, 1, 3, 0, 1, 1] }));
    const output = bgr(await r.apply(message));
    // Native flags1026 output physical rows: 18363b18363b / a1bfc4a1bfc4.
    // Source cursor walks DOWN the first column, then DOWN the second column;
    // it continues into the second destination descriptor.
    const nativeExpected = [24, 54, 59, 161, 191, 196, 24, 54, 59, 161, 191, 196];
    expect(output.length).toBe(nativeExpected.length);
    nativeExpected.forEach((native, i) => {
      // jpeg-js and TurboJPEG need not produce bit-identical lossy decoding.
      expect(Math.abs((output[i] ?? -100) - native)).toBeLessThanOrEqual(8);
    });
  });

  test('modernPipelineCacheCopyJPEGMainAndCaptureHaveNativeOrdering', async () => {
    const r = await renderer({ width: 3, height: 2, tileSize: 1 });
    await r.apply(
      decodeFrameMessage(
        screenParts({
          rectangles: [0, 0, 1, 1],
          pixels: screenWords([0x7c00]),
          additions: concat(screenWords([0, 0, 1, 1]), screenLong(10)),
        }),
      ),
    );
    // A cache hit only changes temp until part5 exposes it. Main raw data then
    // overwrites the auxiliary JPEG. Cache additions observe the final main DIB.
    const second = decodeFrameMessage(
      screenParts({
        sequence: 2,
        rectangles: [2, 1, 1, 1],
        pixels: screenWords([0x7fff]),
        copy: [1, 0, 1, 1],
        jpeg: screenJPEGFixture,
        auxiliary: [2, 0, 1, 2],
        references: concat(screenWords([1, 0]), screenLong(10)),
        additions: concat(screenWords([2, 0, 1, 1]), screenLong(20), screenWords([2, 1, 1, 1]), screenLong(10)),
      }),
    );
    const secondPixels = bgr(await r.apply(second));
    expect(Array.from(secondPixels.subarray(3, 6))).toEqual([0, 0, 255]);
    expect(Array.from(secondPixels.subarray(15, 18))).toEqual([255, 255, 255]);
    const jpegPixel = Array.from(secondPixels.subarray(6, 9));
    const third = decodeFrameMessage(
      screenParts({
        sequence: 3,
        copy: [0, 1, 1, 1, 1, 1, 1, 1],
        references: concat(screenWords([0, 1]), screenLong(20), screenWords([1, 1]), screenLong(10)),
      }),
    );
    const thirdPixels = bgr(await r.apply(third));
    const quantized = jpegPixel.map((channel) => (channel & 0xf8) | (channel >> 5));
    expect(Array.from(thirdPixels.subarray(9, 12))).toEqual(quantized);
    expect(Array.from(thirdPixels.subarray(12, 15))).toEqual([0, 0, 255]); // existing hash 10 was not replaced
    expect(r.cacheEntryCount === 2 && r.cacheByteCount === 4).toBe(true);
  });

  test('modernCacheNativeThousandEntryLimitAndHitRecency', async () => {
    const r = await renderer({ width: 1, height: 1 });
    const additions: Uint8Array[] = [];
    for (let hash = 0; hash < 1000; hash++) additions.push(screenWords([0, 0, 1, 1]), screenLong(hash));
    await r.apply(decodeFrameMessage(screenParts({ additions: concat(...additions) })));
    expect(r.cacheEntryCount).toBe(1000);
    await r.apply(
      decodeFrameMessage(
        screenParts({
          sequence: 2,
          references: concat(screenWords([0, 0]), screenLong(0)),
          additions: concat(screenWords([0, 0, 1, 1]), screenLong(1000)),
        }),
      ),
    );
    expect(r.cacheEntryCount).toBe(1000);
    const evicted = decodeFrameMessage(screenParts({ sequence: 3, references: concat(screenWords([0, 0]), screenLong(1)) }));
    expect(await screenError(r.apply(evicted))).toMatchObject({ code: 'cacheMiss', hash: 1 });
    expect(r.lastFrameNumber).toBe(2);
    await r.apply(decodeFrameMessage(screenParts({ sequence: 3, references: concat(screenWords([0, 0]), screenLong(0)) })));
  });

  test('modernScreenFailuresAreAtomicAndBounded', async () => {
    const r = await renderer({ width: 2, height: 1, limits: { maximumCacheBytes: 2 } });
    const initial = r.snapshot();
    const unchanged = () => {
      expect(r.bitmap.rgba).toEqual(initial.rgba);
      expect(r.lastFrameNumber).toBe(0);
    };
    const oversizedCache = decodeFrameMessage(
      screenParts({
        rectangles: [0, 0, 2, 1],
        pixels: screenWords([0x7c00, 0x03e0]),
        additions: concat(screenWords([0, 0, 1, 1]), screenLong(1), screenWords([1, 0, 1, 1]), screenLong(2)),
      }),
    );
    expect((await screenError(r.apply(oversizedCache))).code).toBe('cacheBudgetExceeded');
    unchanged();
    expect(r.cacheEntryCount).toBe(0);
    const mismatch = decodeFrameMessage(screenParts({ rectangles: [0, 0, 2, 1], pixels: screenWords([0x001f]) }));
    expect(await screenError(r.apply(mismatch))).toMatchObject({
      code: 'decompressedLengthMismatch',
      expected: 4,
      received: 2,
    });
    const invalidJPEG = decodeFrameMessage(screenParts({ jpeg: u8(1, 2, 3), auxiliary: [0, 0, 1, 1] }));
    expect((await screenError(r.apply(invalidJPEG))).code).toBe('invalidJPEG');
    const wrongSequence = decodeFrameMessage(screenParts({ sequence: 2 }));
    expect(await screenError(r.apply(wrongSequence))).toMatchObject({ code: 'sequenceMismatch', expected: 1, received: 2 });
    unchanged();
    await r.apply(decodeFrameMessage(screenParts({ rectangles: [0, 0, 1, 1], pixels: screenWords([0x001f]) })));
    expect(bgr(r.bitmap)).toEqual(hexData('ff0000000000'));
    // The ModernScreenInitialization 8193-column assertion lives in screen-message.test.ts.
  });

  test('modernScreenAuxiliaryBoundsAndTileSizeUpdates', async () => {
    const r = await renderer({ width: 5, height: 1, tileSize: 1 });
    const overflow = decodeFrameMessage(screenParts({ jpeg: screenJPEGFixture, auxiliary: [0, 0, 5, 1] }));
    expect((await screenError(r.apply(overflow))).code).toBe('auxiliaryAtlasOutOfBounds');
    expect(r.lastFrameNumber).toBe(0);
    r.setTileSize([u8(48), u8(2)]);
    expect(r.tileSize).toBe(2);
    expect(caught(() => r.setTileSize([u8(48), u8(0)]))).toMatchObject({ code: 'malformedPart', part: 1 });
    expect(r.tileSize).toBe(2);
  });
});

describe('ModernScreenRenderer (web port additions)', () => {
  test('without an injected decoder, Node has no browser JPEG support: unsupportedJPEG, atomically', async () => {
    const r = await ModernScreenRenderer.create({ width: 2, height: 1, displayColors: 2, lastFrameNumber: 0 });
    const message = decodeFrameMessage(
      screenParts({ rectangles: [0, 0, 1, 1], pixels: screenWords([0x7c00]), jpeg: screenJPEGFixture, auxiliary: [0, 0, 1, 1] }),
    );
    expect((await screenError(r.apply(message))).code).toBe('unsupportedJPEG');
    expect(r.lastFrameNumber).toBe(0);
    expect(bgr(r.bitmap)).toEqual(new Uint8Array(6));
  });

  test('a decoder failure or size disagreement is invalidJPEG', async () => {
    const failing = await renderer({
      width: 2,
      height: 1,
      decodeJpeg: async () => {
        throw new Error('corrupt');
      },
    });
    const message = decodeFrameMessage(screenParts({ jpeg: screenJPEGFixture, auxiliary: [0, 0, 1, 1] }));
    expect((await screenError(failing.apply(message))).code).toBe('invalidJPEG');
    const lying = await renderer({
      width: 2,
      height: 1,
      decodeJpeg: async () => ({ width: 3, height: 2, rgba: new Uint8Array(24) }),
    });
    expect((await screenError(lying.apply(message))).code).toBe('invalidJPEG');
  });

  test('atlas geometry from the JPEG header is checked before decoding', async () => {
    let decoded = false;
    const r = await renderer({
      width: 2,
      height: 1,
      limits: { maximumAtlasDimension: 1 },
      decodeJpeg: async (bytes) => {
        decoded = true;
        return jpegJsDecoder(bytes);
      },
    });
    const message = decodeFrameMessage(screenParts({ jpeg: screenJPEGFixture, auxiliary: [0, 0, 1, 1] }));
    expect((await screenError(r.apply(message))).code).toBe('sizeLimitExceeded');
    expect(decoded).toBe(false);
  });

  test('cache additions outside the screen are invalidGeometry and atomic', async () => {
    const r = await renderer({ width: 2, height: 1 });
    const message = decodeFrameMessage(
      screenParts({ rectangles: [0, 0, 1, 1], pixels: screenWords([0x7c00]), additions: concat(screenWords([1, 0, 2, 1]), screenLong(1)) }),
    );
    expect((await screenError(r.apply(message))).code).toBe('invalidGeometry');
    expect(r.lastFrameNumber).toBe(0);
    expect(r.cacheEntryCount).toBe(0);
    expect(bgr(r.bitmap)).toEqual(new Uint8Array(6));
  });

  test('a cache miss leaves earlier operations of the same frame unapplied', async () => {
    const r = await renderer({ width: 1, height: 1 });
    const message = decodeFrameMessage(
      screenParts({ rectangles: [0, 0, 1, 1], pixels: screenWords([0x7c00]), references: concat(screenWords([0, 0]), screenLong(5)) }),
    );
    expect(await screenError(r.apply(message))).toMatchObject({ code: 'cacheMiss', hash: 5 });
    expect(bgr(r.bitmap)).toEqual(new Uint8Array(3));
  });

  test('concurrent apply calls are serialized in call order', async () => {
    const r = await renderer({ width: 1, height: 1 });
    const a = r.apply(decodeFrameMessage(screenParts({ sequence: 1, jpeg: screenJPEGFixture, auxiliary: [0, 0, 1, 1] })));
    const b = r.apply(decodeFrameMessage(screenParts({ sequence: 2, rectangles: [0, 0, 1, 1], pixels: screenWords([0x001f]) })));
    await Promise.all([a, b]);
    expect(r.lastFrameNumber).toBe(2);
    expect(bgr(r.bitmap)).toEqual(u8(255, 0, 0));
  });

  test('creation validates geometry, tile size and limits', async () => {
    expect((await screenError(renderer({ width: 0, height: 1 }))).code).toBe('invalidGeometry');
    expect((await screenError(renderer({ width: 8193, height: 1 }))).code).toBe('sizeLimitExceeded');
    expect((await screenError(renderer({ width: 1, height: 1, tileSize: 256 }))).code).toBe('invalidGeometry');
    expect((await screenError(renderer({ width: 1, height: 1, limits: { maximumCacheBytes: 0 } }))).code).toBe(
      'sizeLimitExceeded',
    );
  });

  test('limits default to the Swift ModernScreenLimits values', () => {
    expect(screenLimits()).toEqual({
      maximumDimension: 8192,
      maximumPixels: 16 * 1024 * 1024,
      maximumPayloadBytes: 64 * 1024 * 1024,
      maximumDecompressedBytes: 128 * 1024 * 1024,
      maximumRecordsPerPart: 16_384,
      maximumCacheBytes: 64 * 1024 * 1024,
      maximumAuxiliaryTiles: 1_048_576,
      maximumAtlasDimension: 65_535,
    });
  });

  test('clearCache empties the tile cache', async () => {
    const r = await renderer({ width: 1, height: 1 });
    await r.apply(decodeFrameMessage(screenParts({ additions: concat(screenWords([0, 0, 1, 1]), screenLong(7)) })));
    expect(r.cacheEntryCount).toBe(1);
    r.clearCache();
    expect(r.cacheEntryCount === 0 && r.cacheByteCount === 0).toBe(true);
  });
});
