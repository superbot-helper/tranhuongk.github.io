import { beforeAll, describe, expect, test } from 'vitest';
import {
  CursorMessageError,
  IGNORED_SELECTION_HASH,
  type CursorZstd,
  cursorShapeRequest,
  decodeCursorFile,
  decodeCursorMessage,
  makeCursorZstd,
} from './cursor';
import { rawScreenZstd as cursorRawZstd, screenLong as cursorLong } from './screen-test-utils';
import { concat, enc, u8 } from './test-utils';

// A synthetic directory with an opaque four-byte image resource. This validates
// the wire/metadata parser, not an image decoder's ability to read the resource.
function cursorFileFixture(offset = 22): Uint8Array {
  const header = [0, 0, 2, 0, 1, 0, 32, 32, 0, 0, 3, 0, 5, 0, 4, 0, 0, 0];
  const offsetBytes = [0, 1, 2, 3].map((i) => (offset >>> (i * 8)) & 0xff);
  const padding = offset > 22 && offset < 1024 ? new Array<number>(offset - 22).fill(0) : [];
  return u8(...header, ...offsetBytes, ...padding, 0xaa, 0xbb, 0xcc, 0xdd);
}

function cursorError(fn: () => unknown): CursorMessageError {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(CursorMessageError);
  return thrown as CursorMessageError;
}

let zstd: CursorZstd;
beforeAll(async () => {
  zstd = await makeCursorZstd();
});

// Ported from CursorMessageTests.swift.
describe('cursor message (CursorMessageTests.swift)', () => {
  test('cursorSelectionAndCacheMissRequestUseSignedHash', () => {
    const event = decodeCursorMessage([u8(3), concat(cursorLong(-12345), u8(0xff))], zstd);
    expect(event).toEqual({ type: 'select', hash: -12345 });
    expect(cursorShapeRequest(-12345)).toEqual(enc('4|||-12345'));
    // Swift returns .selection(ignored); the browser port reports "ignored" as null.
    expect(IGNORED_SELECTION_HASH).toBe(-1_202_906_512);
    expect(decodeCursorMessage([u8(3), cursorLong(IGNORED_SELECTION_HASH)], zstd)).toBeNull();
  });

  test('cursorShapeUsesIndependentDictionaryFreeZstd', () => {
    const file = cursorFileFixture();
    const decoded = decodeCursorMessage([u8(4), cursorLong(-7), cursorLong(file.length), cursorRawZstd(file)], zstd);
    expect(decoded).toEqual({ type: 'shape', hash: -7, cur: file });
    const cursor = decodeCursorFile((decoded as { cur: Uint8Array }).cur);
    expect(cursor.fileData).toEqual(file);
    expect(cursor.resourceData).toEqual(u8(0xaa, 0xbb, 0xcc, 0xdd));
    expect(cursor.width).toBe(32);
    expect(cursor.height).toBe(32);
    expect(cursor.hotSpotX).toBe(3);
    expect(cursor.hotSpotY).toBe(5);
    expect(cursor.imageCount).toBe(1);
    // Non-modern peers send the raw .CUR in part 2.
    expect(decodeCursorMessage([u8(4), cursorLong(-7), file], zstd, { modern: false })).toEqual(decoded);
  });

  test('cursorPositionIsSignedVirtualDesktopCoordinate', () => {
    expect(decodeCursorMessage([u8(28), u8(0x00, 0x80), u8(0xff, 0x7f)], zstd)).toEqual({
      type: 'position',
      x: -32768,
      y: 32767,
    });
  });

  test('cursorFileValidatesFullOffsetAndHotspotInsteadOfNativeLowByteQuirks', () => {
    const file = cursorFileFixture(278); // Low byte 22 differs from actual 278.
    expect(decodeCursorFile(file).resourceData).toEqual(u8(0xaa, 0xbb, 0xcc, 0xdd));
    let invalid = cursorFileFixture();
    invalid[11] = 1; // Full hotspot 259, despite low byte 3 being in bounds.
    expect(cursorError(() => decodeCursorFile(invalid)).code).toBe('invalidCursorFile');
    invalid = cursorFileFixture();
    invalid[18] = 250;
    expect(cursorError(() => decodeCursorFile(invalid)).code).toBe('invalidCursorFile');
    invalid = cursorFileFixture();
    invalid[14] = 5;
    expect(cursorError(() => decodeCursorFile(invalid)).code).toBe('invalidCursorFile');
  });

  test('cursorMalformedMessagesAndExpansionAreBounded', () => {
    expect(cursorError(() => decodeCursorMessage([u8(3)], zstd))).toMatchObject({ code: 'missingPart', part: 1 });
    expect(cursorError(() => decodeCursorMessage([u8(3), u8(1, 2, 3)], zstd))).toMatchObject({ code: 'malformedPart', part: 1 });
    expect(cursorError(() => decodeCursorMessage([u8(28), u8(1, 0), u8(1)], zstd))).toMatchObject({ code: 'malformedPart', part: 2 });
    const file = cursorFileFixture();
    expect(
      cursorError(() => decodeCursorMessage([u8(4), cursorLong(3), cursorLong(27), cursorRawZstd(file)], zstd)),
    ).toMatchObject({ code: 'decompressedLengthMismatch', expected: 27, received: 26 });
    expect(cursorError(() => decodeCursorMessage([u8(4), cursorLong(3), cursorLong(3_000_000), u8(1)], zstd)).code).toBe(
      'sizeLimitExceeded',
    );
    expect(cursorError(() => decodeCursorMessage([u8(3), cursorLong(3)], zstd, { maximumBytes: 4 })).code).toBe(
      'sizeLimitExceeded',
    );
  });

  // TypeScript-only additions.
  test('unsupported command, empty parts and cursor file bounds', () => {
    expect(cursorError(() => decodeCursorMessage([u8(5)], zstd))).toMatchObject({ code: 'unsupportedCommand', command: 5 });
    expect(cursorError(() => decodeCursorMessage([], zstd))).toMatchObject({ code: 'missingPart', part: 0 });
    expect(cursorError(() => decodeCursorMessage([new Uint8Array()], zstd))).toMatchObject({ code: 'missingPart', part: 0 });
    expect(cursorError(() => decodeCursorMessage([u8(3)], zstd, { maximumBytes: 0 })).code).toBe('sizeLimitExceeded');
    expect(cursorError(() => decodeCursorFile(cursorFileFixture(), 10)).code).toBe('sizeLimitExceeded');
    expect(cursorError(() => decodeCursorFile(u8(0, 0, 2, 0))).code).toBe('invalidCursorFile');
    // A negative expected length is rejected before any decompression.
    expect(cursorError(() => decodeCursorMessage([u8(4), cursorLong(1), cursorLong(-1), u8(1)], zstd)).code).toBe('sizeLimitExceeded');
    // A shape whose decompressed bytes are not a valid .CUR is rejected.
    const junk = enc('not a cursor file at all, long enough');
    expect(
      cursorError(() => decodeCursorMessage([u8(4), cursorLong(1), cursorLong(junk.length), cursorRawZstd(junk)], zstd)).code,
    ).toBe('invalidCursorFile');
  });

  test('makeCursorZstd is reusable after a failure and rejects over-limit output', async () => {
    const file = cursorFileFixture();
    expect(() => zstd(u8(1, 2, 3), 3)).toThrow();
    expect(zstd(cursorRawZstd(file), file.length)).toEqual(file);
    const small = await makeCursorZstd(8);
    expect(() => small(cursorRawZstd(file), file.length)).toThrow();
    expect(small(cursorRawZstd(u8(1, 2, 3)), 3)).toEqual(u8(1, 2, 3));
  });

  test('cursorShapeRequest rejects a non-integer hash', () => {
    expect(() => cursorShapeRequest(1.5)).toThrow(RangeError);
    expect(cursorShapeRequest(0)).toEqual(enc('4|||0'));
  });
});
