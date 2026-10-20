import { describe, expect, test } from 'vitest';
import {
  ModernScreenMessageError,
  checkAtlasGeometry,
  checkGeometry,
  decodeFrameMessage,
  decodeInitialization,
  screenLimits,
} from './screen-message';
import { caught, screenLong, screenParts, screenWords } from './screen-test-utils';
import { concat, enc, u8 } from './test-utils';

function screenError(fn: () => unknown): ModernScreenMessageError {
  const error = caught(fn);
  expect(error).toBeInstanceOf(ModernScreenMessageError);
  return error as ModernScreenMessageError;
}

// Ported from ModernScreenTests.swift (message-decoding tests; renderer tests are
// in screen-renderer.test.ts).
describe('ModernScreenMessage (ModernScreenTests.swift)', () => {
  test('modernScreenPartsHaveRecoveredSignednessAndPositions', () => {
    const parts = screenParts({
      sequence: -7,
      rectangles: [65_535, 2, 3, 4],
      copy: [-1, -2, 3, 4],
      scroll: [-5, -6, 7, 8, 9, 10, 11, 12, 13],
      jpeg: u8(0xaa),
      auxiliary: [-14, 15, 16, 17],
      references: concat(screenWords([-18, 19]), screenLong(-20)),
      additions: concat(screenWords([-21, 22, 23, 24]), screenLong(-25)),
    });
    const message = decodeFrameMessage(parts);
    expect(message.frameNumber).toBe(-7);
    expect(message.mainRectangles).toEqual([{ x: 65_535, y: 2, width: 3, height: 4 }]);
    expect(message.copyFromTemporary).toEqual([{ x: -1, y: -2, width: 3, height: 4 }]);
    expect(message.scroll?.verticalDelta).toBe(-5);
    expect(message.scroll?.capture).toEqual({ x: -6, y: 7, width: 8, height: 9 });
    expect(message.scroll?.copyBack).toEqual([{ x: 10, y: 11, width: 12, height: 13 }]);
    expect(message.auxiliaryJPEG).toEqual(u8(0xaa));
    expect(message.auxiliaryRectangles).toEqual([{ x: -14, y: 15, width: 16, height: 17 }]);
    expect(message.cacheReferences[0]?.hash).toBe(-20);
    expect(message.cacheReferences[0]?.x).toBe(-18);
    expect(message.cacheAdditions[0]?.hash).toBe(-25);
    expect(message.cacheAdditions[0]?.region).toEqual({ x: -21, y: 22, width: 23, height: 24 });
  });

  test('modernScreenInitializationAndMalformedParts', () => {
    const initParts: Uint8Array[] = [u8(0), screenLong(1920), screenLong(1080)];
    const basic = decodeInitialization(initParts);
    expect(basic.width === 1920 && basic.height === 1080 && basic.tileSize === 16).toBe(true);
    while (initParts.length < 15) initParts.push(new Uint8Array());
    initParts[5] = u8(0);
    initParts[6] = enc('6.6.125');
    initParts[7] = u8(1);
    initParts[8] = enc('monitor');
    initParts[9] = screenLong(-1920);
    initParts[10] = screenLong(100);
    initParts[11] = u8(0);
    initParts[12] = screenWords([-1]);
    initParts[13] = u8(3);
    initParts[14] = u8(32);
    const full = decodeInitialization(initParts);
    expect(full.virtualLeft === -1920 && full.virtualTop === 100 && full.tileSize === 32).toBe(true);
    expect(full.targetVersionBytes).toEqual(enc('6.6.125'));
    expect(screenError(() => decodeInitialization(initParts.slice(0, 9)))).toMatchObject({ code: 'missingPart', part: 9 });
    expect(screenError(() => decodeInitialization(initParts.slice(0, 7)))).toMatchObject({ code: 'missingPart', part: 7 });
    for (const index of [5, 7, 11, 12]) {
      const truncated = initParts.slice();
      truncated[index] = new Uint8Array();
      expect(screenError(() => decodeInitialization(truncated))).toMatchObject({ code: 'malformedPart', part: index });
    }
    const shortLicense = initParts.slice();
    shortLicense[12] = u8(0xff); // native reads signed Int16 at offset zero
    expect(screenError(() => decodeInitialization(shortLicense))).toMatchObject({ code: 'malformedPart', part: 12 });
    const ignoredOrStringSlots = initParts.slice();
    for (const index of [3, 4, 6, 8, 13]) ignoredOrStringSlots[index] = new Uint8Array();
    // Empty ANSI strings are valid. Part 13 is only consumed in the native
    // geometry-change branch, which is outside this stateless metadata decoder.
    const emptyMetadata = decodeInitialization(ignoredOrStringSlots);
    expect(emptyMetadata.targetVersionBytes).toEqual(new Uint8Array());
    expect(emptyMetadata.monitorInformationBytes).toEqual(new Uint8Array());
    let parts = screenParts();
    expect(screenError(() => decodeFrameMessage(parts.slice(0, 10)))).toMatchObject({ code: 'missingPart', part: 10 });
    for (const index of [1, 5, 6, 8, 9, 10]) {
      parts = screenParts();
      parts[index] = u8(0);
      expect(screenError(() => decodeFrameMessage(parts))).toMatchObject({ code: 'malformedPart', part: index });
    }
    parts = screenParts();
    parts[0] = u8(31);
    expect(screenError(() => decodeFrameMessage(parts))).toMatchObject({ code: 'unsupportedCommand', command: 31 });
    // The renderer's displayColors == 1 assertion lives in screen-renderer.test.ts.
  });

  test('ModernScreenInitialization rejects 8193 columns (from modernScreenFailuresAreAtomicAndBounded)', () => {
    expect(screenError(() => decodeInitialization([u8(0), screenLong(8193), screenLong(1)])).code).toBe(
      'sizeLimitExceeded',
    );
  });

  test('modernAtlasHasIndependentDimensionAndPixelBudgets', () => {
    const limits = screenLimits();
    // Actual Windows atlas dimensions, with no captured image data in this test.
    checkAtlasGeometry(limits, 32, 19_904);
    expect(screenError(() => checkGeometry(limits, 32, 19_904)).code).toBe('sizeLimitExceeded');
    for (const [width, height] of [[32, 65_536], [65_535, 65_535]] as const) {
      expect(screenError(() => checkAtlasGeometry(limits, width, height)).code).toBe('sizeLimitExceeded');
    }
    expect(screenError(() => checkAtlasGeometry(limits, 0, 100)).code).toBe('invalidGeometry');
  });
});

describe('ModernScreenMessage (web port additions)', () => {
  test('empty parts list and empty header', () => {
    expect(screenError(() => decodeFrameMessage([]))).toMatchObject({ code: 'missingPart', part: 0 });
    expect(screenError(() => decodeFrameMessage([new Uint8Array()]))).toMatchObject({ code: 'malformedPart', part: 0 });
  });

  test('total part size is bounded by maximumPayloadBytes', () => {
    const limits = screenLimits({ maximumPayloadBytes: 10 });
    const parts = screenParts();
    parts[7] = new Uint8Array(11);
    expect(screenError(() => decodeFrameMessage(parts, limits)).code).toBe('sizeLimitExceeded');
  });

  test('records per part are bounded', () => {
    const limits = screenLimits({ maximumRecordsPerPart: 1 });
    expect(
      screenError(() => decodeFrameMessage(screenParts({ rectangles: [0, 0, 1, 1, 0, 0, 1, 1] }), limits)).code,
    ).toBe('sizeLimitExceeded');
  });

  test('zero-sized regions are invalidGeometry', () => {
    expect(screenError(() => decodeFrameMessage(screenParts({ rectangles: [0, 0, 0, 1] }))).code).toBe(
      'invalidGeometry',
    );
  });

  test('scroll part with a bad tail length is malformedPart(6)', () => {
    const parts = screenParts();
    parts[6] = new Uint8Array(12);
    expect(screenError(() => decodeFrameMessage(parts))).toMatchObject({ code: 'malformedPart', part: 6 });
  });

  test('invalid limits are rejected', () => {
    expect(screenError(() => decodeFrameMessage(screenParts(), screenLimits({ maximumPixels: 0 }))).code).toBe(
      'sizeLimitExceeded',
    );
  });

  test('user-facing text follows the Swift errorDescription', () => {
    expect(new ModernScreenMessageError('cacheMiss', { hash: 3 }).userMessage).toBe(
      'A Windows screen update refers to a missing image tile.',
    );
  });
});
