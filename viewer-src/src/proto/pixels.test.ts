import { describe, expect, test } from 'vitest';
import {
  ScreenRectangleBuffer,
  ScreenRectangleBufferError,
  bgr24FromRGBA,
  expandRGB555,
  opaqueBlack,
  packRGB555,
} from './pixels';
import { concat, expectError, rep, u8 } from './test-utils';

const MAX = Number.MAX_SAFE_INTEGER; // stands in for Swift's Int.max
const MIN = -Number.MAX_SAFE_INTEGER; // stands in for Swift's Int.min

// Ported from ScreenPixelStorageTests.swift. The web port stores RGBA (ImageData
// order) instead of BGRA, so expected channel bytes are written R, G, B, A; the
// RGB555 inputs and the 5→8 bit expansion are unchanged.
describe('pixel kernels (ScreenPixelStorageTests.swift)', () => {
  test('screenPixelExpansionMatchesEveryRGB555WordAndUnusedBit', () => {
    const count = 65_536;
    const input = new Uint8Array(1 + count * 2 + 1).fill(0xa5);
    const expected = new Uint8Array(count * 4);
    const expectedPacked = new Uint8Array(1 + count * 2 + 1).fill(0xa5);
    for (let value = 0; value < count; value++) {
      input[1 + value * 2] = value & 0xff;
      input[2 + value * 2] = value >> 8;
      expectedPacked[1 + value * 2] = value & 0xff;
      expectedPacked[2 + value * 2] = (value >> 8) & 0x7f;
      [10, 5, 0].forEach((shift, channel) => {
        const five = (value >> shift) & 31;
        expected[value * 4 + channel] = (five << 3) | (five >> 2);
      });
      expected[value * 4 + 3] = 255;
    }
    // Deliberately unaligned regions also verify that the kernels do not assume
    // alignment, nor overwrite the surrounding sentinel bytes.
    const output = new Uint8Array(3 + count * 4 + 5).fill(0xa5);
    expandRGB555(input, 1, 512, output, 3, 1024, 256, 256);
    expect(output).toEqual(concat(rep(0xa5, 3), expected, rep(0xa5, 5)));
    const packed = new Uint8Array(input.length).fill(0xa5);
    packRGB555(output, 3, 1024, packed, 1, 512, 256, 256);
    expect(packed).toEqual(expectedPacked);
  });

  test('aligned fast path matches the byte path for every RGB555 word', () => {
    const count = 65_536;
    const input = new Uint8Array(count * 2);
    for (let value = 0; value < count; value++) {
      input[value * 2] = value & 0xff;
      input[value * 2 + 1] = value >> 8;
    }
    const aligned = new Uint8Array(count * 4);
    const unaligned = new Uint8Array(count * 4 + 1);
    expandRGB555(input, 0, 512, aligned, 0, 1024, 256, 256);
    expandRGB555(input, 0, 512, unaligned, 1, 1024, 256, 256);
    expect(aligned).toEqual(unaligned.subarray(1));
  });

  test('screenPixelKernelsPreserveOddWidthPaddingAndReversedRows', () => {
    // Converter physical rows are bottom-up, three pixels plus DWORD padding.
    const bottom = u8(0xff, 0x7f, 0, 0, 0x10, 0x42);
    const top = u8(0, 0x7c, 0xe0, 3, 0x1f, 0);
    const padding = u8(0xa5, 0xa5);
    const input = concat(u8(0xa5), bottom, padding, top, padding);
    const output = new Uint8Array(3 + 32 + 5).fill(0xa5);
    expandRGB555(input, 9, -8, output, 3, 16, 3, 2);
    // Swift BGRA [0,0,255,255, 0,255,0,255, 255,0,0,255] in RGBA order:
    const expectedTop = u8(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255);
    // Swift BGRA [255,255,255,255, 0,0,0,255, 132,132,132,255]:
    const expectedBottom = u8(255, 255, 255, 255, 0, 0, 0, 255, 132, 132, 132, 255);
    const expected = concat(rep(0xa5, 3), expectedTop, rep(0xa5, 4), expectedBottom, rep(0xa5, 9));
    expect(output).toEqual(expected);
    const packed = new Uint8Array(input.length).fill(0xa5);
    packRGB555(output, 3, 16, packed, 9, -8, 3, 2);
    expect(packed).toEqual(input);
  });

  test('screenBitmapNativeStoragePreservesBGRView (CoreGraphics part not applicable)', () => {
    // Swift checked CGImage channel interpretation. The web bitmap is fed to
    // ImageData, whose byte order is R, G, B, A (non-premultiplied); assert that
    // layout directly and that the BGR24 compatibility view round-trips.
    const bgr = u8(1, 2, 3, 255, 0, 0, 0, 255, 0, 0, 0, 255, 33, 66, 99, 255, 255, 255);
    const rgba = new Uint8ClampedArray(24);
    for (let i = 0, j = 0; i < bgr.length; i += 3, j += 4) {
      rgba[j] = bgr[i + 2] ?? 0;
      rgba[j + 1] = bgr[i + 1] ?? 0;
      rgba[j + 2] = bgr[i] ?? 0;
      rgba[j + 3] = 255;
    }
    expect(bgr24FromRGBA(rgba, 3, 2)).toEqual(bgr);
    expect(Array.from(rgba.subarray(0, 8))).toEqual([3, 2, 1, 255, 0, 0, 255, 255]);
  });

  test('opaqueBlack fills RGBA 0,0,0,255', () => {
    expect(Array.from(opaqueBlack(2, 1))).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });
});

// Ported from ScreenRectangleTests.swift.
describe('ScreenRectangleBuffer (ScreenRectangleTests.swift)', () => {
  test('recoveredRectangleCopyPreservesPixelBytesAndBottomUpPadding', () => {
    // A 2×2, three-byte-per-pixel top-down fixture. Channel order remains opaque.
    const source = u8(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
    const canvas = new ScreenRectangleBuffer(2, 2, 3, 8, rep(99, 16));
    canvas.copyRectangle(source, 2, 2, 0, 0);
    expect(canvas.pixels).toEqual(u8(7, 8, 9, 10, 11, 12, 99, 99, 1, 2, 3, 4, 5, 6, 99, 99));
  });

  test('recoveredRectangleClippingUsesCorrespondingSourcePixels', () => {
    const canvas = new ScreenRectangleBuffer(3, 2, 1, 5, rep(99, 10));
    const source = u8(1, 2, 3, 4, 5, 6);
    canvas.copyRectangle(source, 3, 2, -1, 0);
    expect(canvas.pixels).toEqual(u8(5, 6, 99, 99, 99, 2, 3, 99, 99, 99));
    // The first source row lies above the destination and must be skipped.
    canvas.copyRectangle(source, 3, 2, 0, -1);
    expect(canvas.pixels).toEqual(u8(5, 6, 99, 99, 99, 4, 5, 6, 99, 99));
    // Only the top-left source pixel intersects the destination's bottom-right.
    canvas.copyRectangle(source, 3, 2, 2, 1);
    expect(canvas.pixels).toEqual(u8(5, 6, 1, 99, 99, 4, 5, 6, 99, 99));
  });

  test('rectangleOffscreenPlacementAndSlicedDataAreSafe', () => {
    const backing = u8(99, 0, 0, 0, 0, 77);
    const canvas = new ScreenRectangleBuffer(2, 2, 1, 2, backing.subarray(1, 5));
    const source = u8(99, 1, 2, 3, 4).subarray(1);
    for (const [x, y] of [[2, 0], [0, 2], [-2, 0], [0, -2], [MIN, MAX]] as const) {
      canvas.copyRectangle(source, 2, 2, x, y);
      expect(canvas.pixels).toEqual(u8(0, 0, 0, 0));
    }
    canvas.copyRectangle(source, 2, 2, 0, 0);
    expect(canvas.pixels).toEqual(u8(3, 4, 1, 2));
    expect(backing[0]).toBe(99);
    expect(backing[5]).toBe(77);
  });

  test('rectangleRejectsMalformedSizesBeforeModifyingPixels', () => {
    expectError(() => new ScreenRectangleBuffer(0, 1, 1, 1, u8(0)), ScreenRectangleBufferError, 'invalidGeometry');
    expectError(() => new ScreenRectangleBuffer(2, 1, 3, 5, new Uint8Array(5)), ScreenRectangleBufferError, 'invalidStride');
    expectError(
      () => new ScreenRectangleBuffer(2, 1, 3, 6, new Uint8Array(5)),
      ScreenRectangleBufferError,
      'invalidDestinationLength',
    );
    expectError(() => new ScreenRectangleBuffer(MAX, 1, 2, MAX, new Uint8Array()), ScreenRectangleBufferError, 'sizeOverflow');
    const canvas = new ScreenRectangleBuffer(1, 1, 3, 3, u8(7, 8, 9));
    expectError(() => canvas.copyRectangle(u8(1, 2), 1, 1, 0, 0), ScreenRectangleBufferError, 'truncatedSource');
    expectError(() => canvas.copyRectangle(new Uint8Array(), MAX, 1, 0, 0), ScreenRectangleBufferError, 'sizeOverflow');
    expect(canvas.pixels).toEqual(u8(7, 8, 9));
  });

  test('non-integer geometry is invalidGeometry (web port: JS numbers are not Ints)', () => {
    expectError(() => new ScreenRectangleBuffer(1.5, 1, 1, 2, u8(0, 0)), ScreenRectangleBufferError, 'invalidGeometry');
    const canvas = new ScreenRectangleBuffer(1, 1, 1, 1, u8(0));
    expectError(() => canvas.copyRectangle(u8(1), 1, 1, 0.5, 0), ScreenRectangleBufferError, 'invalidGeometry');
  });
});
