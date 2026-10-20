import { describe, expect, test } from 'vitest';
import { CurDecodeError, decodeCur, decodeCurAsync, type PngDecoder } from './cur-decode';
import { curFile, dib, long, pngStub } from './cur-test-utils';

// Fixtures port MacViewerTests/RemoteCursorPresenterTests.swift (same DIB bytes). Swift reads
// the CGImage back as premultiplied-first BGRA; the port returns straight RGBA, so the expected
// pixel bytes below are the Swift vectors with B and R swapped.

const rgba = (...v: number[]) => Uint8ClampedArray.from(v);

describe('decodeCur (DIB)', () => {
  test('classic 32-bit DIB cursor: bottom-up rows, hotspot, straight RGBA', () => {
    const resource = [
      ...long(40), ...long(2), ...long(4), 1, 0, 32, 0,
      ...[0, 16, 0, 0, 0, 0].flatMap(long),
      // Bottom-up BGRA colour rows, then DWORD-aligned AND-mask rows.
      255, 0, 0, 255, 255, 255, 255, 255,
      0, 0, 255, 255, 0, 255, 0, 255,
      ...new Array<number>(8).fill(0),
    ];
    const cur = decodeCur(curFile(resource, 2, 2, 1));
    expect([cur.width, cur.height, cur.hotX, cur.hotY]).toEqual([2, 2, 1, 0]);
    expect(cur.rgba).toEqual(rgba(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255));
  });

  test('DIB alpha overrides the AND mask; all-zero alpha uses the legacy AND mask', () => {
    const alpha = dib({ width: 2, height: 1, bits: 32, pixelRows: [0, 0, 255, 128, 0, 255, 0, 0], maskRows: [0xc0, 0, 0, 0] });
    expect(decodeCur(curFile(alpha, 2, 1)).rgba).toEqual(rgba(255, 0, 0, 128, 0, 0, 0, 0));
    const legacy = dib({ width: 2, height: 1, bits: 32, pixelRows: [0, 0, 0, 0, 0, 0, 255, 0], maskRows: [0x80, 0, 0, 0] });
    expect(decodeCur(curFile(legacy, 2, 1)).rgba).toEqual(rgba(0, 0, 0, 0, 255, 0, 0, 255));
  });

  test('top-down 24-bit DIB honours DWORD row padding', () => {
    // Three 24bpp pixels need nine data bytes and three padding bytes per row.
    const resource = dib({
      width: 3, height: 2, bits: 24, topDown: true,
      pixelRows: [0, 255, 255, 255, 0, 255, 255, 255, 0, 0xaa, 0xbb, 0xcc, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0xdd, 0xee, 0xff],
      maskRows: new Array<number>(8).fill(0),
    });
    expect(decodeCur(curFile(resource, 3, 2)).rgba).toEqual(
      rgba(255, 255, 0, 255, 255, 0, 255, 255, 0, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255),
    );
  });

  test('monochrome DIB uses the palette, MSB-first bits and bottom-up masks', () => {
    const resource = dib({
      width: 3, height: 2, bits: 1, colors: [0, 0, 0, 0, 255, 255, 255, 0], colorsUsed: 2,
      pixelRows: [0x40, 0, 0, 0, 0xa0, 0, 0, 0], maskRows: [0, 0, 0, 0, 0x40, 0, 0, 0],
    });
    expect(decodeCur(curFile(resource, 3, 2)).rgba).toEqual(
      rgba(255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255),
    );
  });

  test('4-bit and 8-bit palettes and the 16-bit expansion', () => {
    const palette = [0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0]; // red, green, blue (BGRA entries)
    const eight = dib({ width: 2, height: 1, bits: 8, colors: [0, 0, 255, 0, 0, 255, 0, 0], colorsUsed: 2, pixelRows: [1, 0, 0, 0], maskRows: [0, 0, 0, 0] });
    expect(decodeCur(curFile(eight, 2, 1)).rgba).toEqual(rgba(0, 255, 0, 255, 255, 0, 0, 255));
    const four = dib({ width: 3, height: 1, bits: 4, colors: palette, colorsUsed: 3, pixelRows: [0x01, 0x20, 0, 0], maskRows: [0, 0, 0, 0] });
    expect(decodeCur(curFile(four, 3, 1)).rgba).toEqual(rgba(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255));
    // 5-5-5: 0x7fff is white, 0x001f is pure blue, 0x7c00 pure red.
    const sixteen = dib({ width: 3, height: 1, bits: 16, pixelRows: [0xff, 0x7f, 0x1f, 0x00, 0x00, 0x7c, 0, 0], maskRows: [0, 0, 0, 0] });
    expect(decodeCur(curFile(sixteen, 3, 1)).rgba).toEqual(rgba(255, 255, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255));
  });

  test('core (12-byte) header DIB', () => {
    const resource = [...long(12), 2, 0, 2, 0, 1, 0, 24, 0,
      // 2x1, 24bpp bottom-up: BGR BGR + 2 pad bytes; AND mask 4 bytes.
      255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0];
    // Core-header height is doubled (2 = 1 * 2).
    const cur = decodeCur(curFile(resource, 2, 1));
    expect(cur.rgba).toEqual(rgba(0, 0, 255, 255, 0, 255, 0, 255));
  });

  test.each([
    ['truncated mask', (v: number[]) => v.slice(0, -1)],
    ['mask missing', (v: number[]) => v.slice(0, 43)],
  ])('malformed DIB throws: %s', (_name, mutate) => {
    const valid = dib({ width: 2, height: 1, bits: 32, pixelRows: [0, 0, 255, 255, 0, 255, 0, 255], maskRows: [0, 0, 0, 0] });
    expect(() => decodeCur(curFile(mutate(valid), 2, 1))).toThrow(CurDecodeError);
  });

  test('palette index beyond the colour table throws', () => {
    const bad = dib({ width: 2, height: 1, bits: 8, colors: [0, 0, 0, 0], colorsUsed: 1, pixelRows: [0, 1, 0, 0], maskRows: [0, 0, 0, 0] });
    expect(() => decodeCur(curFile(bad, 2, 1))).toThrow(CurDecodeError);
  });

  test('inverting pixels (AND=1, XOR!=0) cannot be a static image and throw like Swift', () => {
    const inversion = dib({
      width: 2, height: 1, bits: 1, colors: [0, 0, 0, 0, 255, 255, 255, 0], colorsUsed: 2,
      pixelRows: [0x80, 0, 0, 0], maskRows: [0x80, 0, 0, 0],
    });
    expect(() => decodeCur(curFile(inversion, 2, 1))).toThrow(expect.objectContaining({ code: 'unrepresentableInversion' }));
  });

  test('geometry mismatch (DIB width 4096 in a 2x2 entry) and unknown resources throw', () => {
    const oversized = [...long(40), ...long(4096), ...long(4), 1, 0, 32, 0, ...new Array<number>(24).fill(0)];
    expect(() => decodeCur(curFile(oversized, 2, 2))).toThrow(expect.objectContaining({ code: 'unsafeGeometry' }));
    expect(() => decodeCur(curFile([0xaa, 0xbb, 0xcc, 0xdd], 2, 2))).toThrow(CurDecodeError);
  });

  test('a container error is thrown by decodeCursorFile', () => {
    expect(() => decodeCur(Uint8Array.of(1, 2, 3))).toThrow();
  });
});

describe('PNG resources', () => {
  test('sync decode refuses PNG; async decodes it through the injected decoder with the validated hotspot', async () => {
    const file = curFile(pngStub(2, 2), 2, 2, 1, 1);
    expect(() => decodeCur(file)).toThrow(expect.objectContaining({ code: 'pngRequiresDecoder' }));
    const png: PngDecoder = async (bytes) => {
      expect([...bytes.slice(0, 4)]).toEqual([137, 80, 78, 71]);
      return { width: 2, height: 2, rgba: new Uint8ClampedArray(16).fill(255) };
    };
    const cur = await decodeCurAsync(file, png);
    expect([cur.width, cur.height, cur.hotX, cur.hotY]).toEqual([2, 2, 1, 1]);
    expect(cur.rgba.length).toBe(16);
  });

  test('PNG larger than the entry or than 256, or decoded to other dimensions, throws', async () => {
    const never: PngDecoder = async () => {
      throw new Error('must not decode');
    };
    await expect(decodeCurAsync(curFile(pngStub(257, 1), 256, 1), never)).rejects.toMatchObject({ code: 'unsafeGeometry' });
    const wrong: PngDecoder = async () => ({ width: 3, height: 2, rgba: new Uint8ClampedArray(24) });
    await expect(decodeCurAsync(curFile(pngStub(2, 2), 2, 2), wrong)).rejects.toMatchObject({ code: 'unsafeGeometry' });
  });

  test('async decode of a DIB cursor needs no PNG decoder', async () => {
    const resource = dib({ width: 2, height: 1, bits: 32, pixelRows: [0, 0, 255, 255, 0, 255, 0, 255], maskRows: [0, 0, 0, 0] });
    const cur = await decodeCurAsync(curFile(resource, 2, 1));
    expect(cur.rgba).toEqual(rgba(255, 0, 0, 255, 0, 255, 0, 255));
  });
});
