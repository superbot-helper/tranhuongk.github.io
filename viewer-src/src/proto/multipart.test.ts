import { describe, expect, test } from 'vitest';
import { MultipartPayloadError, decodeMultipart, encodeMultipart } from './multipart';
import { expectError, u8 } from './test-utils';

// Ported from MultipartPayloadTests.swift.
describe('multipart (MultipartPayloadTests.swift)', () => {
  test('multipartBinaryAndEmptyPartsHaveIndependentLengths', () => {
    const parts = [u8(0), u8(255, 0, 128, 58), new Uint8Array(), new Uint8Array(), u8(65)];
    const expected = u8(
      1, 0, 0, 0, 0,
      4, 0, 0, 0, 255, 0, 128, 58,
      0, 0, 0, 0,
      0, 0, 0, 0,
      1, 0, 0, 0, 65,
    );
    expect(encodeMultipart(parts)).toEqual(expected);
    expect(decodeMultipart(expected)).toEqual(parts);
    expect(decodeMultipart(u8(0, 0, 0, 0))).toEqual([new Uint8Array()]);
  });

  test('multipartPreservesDataSliceCoordinates', () => {
    const framed = u8(99, 98, 1, 0, 0, 0, 42, 0, 0, 0, 0, 97);
    const slice = framed.subarray(2, framed.length - 1);
    expect(slice.byteOffset).not.toBe(0);
    expect(decodeMultipart(slice)).toEqual([u8(42), new Uint8Array()]);
    expect(encodeMultipart([slice.subarray(4, 5)])).toEqual(u8(1, 0, 0, 0, 42));
  });

  test('multipartRejectsMalformedRecordsWithoutGuessingCommands', () => {
    for (const bytes of [u8(0), u8(0, 0), u8(0, 0, 0)]) {
      expectError(() => decodeMultipart(bytes), MultipartPayloadError, 'truncatedLength');
    }
    expectError(() => decodeMultipart(u8(3, 0, 0, 0, 1, 2)), MultipartPayloadError, 'truncatedPart');
    for (const header of [u8(0, 0, 0, 128), u8(255, 255, 255, 255)]) {
      expectError(() => decodeMultipart(header), MultipartPayloadError, 'invalidLength');
    }
    expectError(() => decodeMultipart(new Uint8Array()), MultipartPayloadError, 'emptyPayload');
    expectError(() => encodeMultipart([]), MultipartPayloadError, 'emptyPayload');
  });

  test('multipartEnforcesLocalBudgetsBeforeAllocatingParts', () => {
    const limits = { maximumPayloadLength: 10, maximumPartLength: 2, maximumPartCount: 2 };
    const exact = u8(2, 0, 0, 0, 1, 2, 0, 0, 0, 0);
    expect(decodeMultipart(exact, limits)).toEqual([u8(1, 2), new Uint8Array()]);
    expect(encodeMultipart([u8(1, 2), new Uint8Array()], limits)).toEqual(exact);
    expectError(() => decodeMultipart(u8(255, 255, 255, 127), limits), MultipartPayloadError, 'partTooLarge');
    expectError(() => encodeMultipart([u8(1, 2, 3)], limits), MultipartPayloadError, 'partTooLarge');
    expectError(() => encodeMultipart([u8(1, 2), u8(3)], limits), MultipartPayloadError, 'payloadTooLarge');
    expectError(() => decodeMultipart(new Uint8Array([...exact, 0]), limits), MultipartPayloadError, 'payloadTooLarge');
    const countLimit = { maximumPayloadLength: 16, maximumPartCount: 2 };
    expectError(() => decodeMultipart(new Uint8Array(12), countLimit), MultipartPayloadError, 'tooManyParts');
    expectError(
      () => encodeMultipart([new Uint8Array(), new Uint8Array(), new Uint8Array()], countLimit),
      MultipartPayloadError,
      'tooManyParts',
    );
  });
});
