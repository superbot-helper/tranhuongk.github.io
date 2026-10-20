import { describe, expect, test } from 'vitest';
import { FrameDecoder, LengthPrefixedFrameError, encodeFrame } from './frame';
import { concat, expectError, rep, splitAt, u8 } from './test-utils';

// Ported from FrameTests.swift.
describe('frame (FrameTests.swift)', () => {
  test('capturedBuilderConstants', () => {
    expect(encodeFrame(new Uint8Array())).toEqual(u8(0, 0, 0, 0));
    expect(encodeFrame(u8(1, 2, 3))).toEqual(u8(3, 0, 0, 0, 1, 2, 3));
    expect(encodeFrame(rep(42, 256)).slice(0, 4)).toEqual(u8(0, 1, 0, 0));
  });

  test('streamFragmentationAndCoalescing', () => {
    const payloads = [new Uint8Array(), u8(1, 2, 3), rep(42, 256), new Uint8Array()];
    const stream = concat(...payloads.map(encodeFrame));
    for (let split = 0; split <= stream.length; split++) {
      const decoder = new FrameDecoder();
      const results = [
        ...decoder.push(stream.slice(0, split)),
        ...decoder.push(stream.slice(split)),
      ];
      expect(results).toEqual(payloads);
      expect(decoder.hasIncompleteFrame).toBe(false);
    }
    const decoder = new FrameDecoder();
    const results: Uint8Array[] = [];
    for (const byte of stream) results.push(...decoder.push(u8(byte)));
    expect(results).toEqual(payloads);
  });

  test('rejectsOversizeAndNegativeLengths', () => {
    const decoder = new FrameDecoder(1024);
    expectError(() => decoder.push(u8(1, 4, 0, 0)), LengthPrefixedFrameError, 'frameTooLarge');
    expect(decoder.hasIncompleteFrame).toBe(false);
    expectError(() => decoder.push(u8(255, 255, 255, 255)), LengthPrefixedFrameError, 'invalidLength');
    expect(decoder.hasIncompleteFrame).toBe(false);
  });

  test('incompleteStreamAndReset', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(u8(5, 0, 0, 0, 42))).toEqual([]);
    expect(decoder.hasIncompleteFrame).toBe(true);
    decoder.reset();
    expect(decoder.hasIncompleteFrame).toBe(false);
    expect(decoder.push(u8(0, 0, 0, 0))).toEqual([new Uint8Array()]);
  });
});

// Review Focus 3 (task brief).
describe('frame decoder, arbitrary TCP chunking', () => {
  test('frame decoder handles arbitrary splits and coalescing', () => {
    const frames = [new Uint8Array([1]), new Uint8Array(70000).fill(7), new Uint8Array(0)];
    const wire = concat(...frames.map(encodeFrame));
    for (const cuts of [[1], [3, 4, 5], [70001], [wire.length - 1]]) {
      const d = new FrameDecoder();
      const out = splitAt(wire, cuts).flatMap((c) => d.push(c));
      expect(out).toEqual(frames);
      expect(d.hasIncompleteFrame).toBe(false);
    }
  });

  test('three frames in one chunk, and one frame across three chunks', () => {
    const frames = [u8(1), u8(2, 2), u8(3, 3, 3)];
    const wire = concat(...frames.map(encodeFrame));
    expect(new FrameDecoder().push(wire)).toEqual(frames);
    const d = new FrameDecoder();
    const body = rep(9, 100);
    const wire1 = encodeFrame(body);
    const out = splitAt(wire1, [2, 50]).flatMap((c) => d.push(c));
    expect(out).toEqual([body]);
  });

  test('frame over 16 MiB throws frameTooLarge', () => {
    // 0x01000001 little-endian = 16 MiB + 1.
    const d = new FrameDecoder();
    expectError(() => d.push(u8(0x01, 0x00, 0x00, 0x01)), LengthPrefixedFrameError, 'frameTooLarge');
    expect(d.hasIncompleteFrame).toBe(false);
    // Exactly 16 MiB header is accepted (body not yet delivered).
    const ok = new FrameDecoder();
    expect(ok.push(u8(0x00, 0x00, 0x00, 0x01))).toEqual([]);
    expect(ok.hasIncompleteFrame).toBe(true);
  });

  test('over-limit header split across chunks still throws and resets', () => {
    const d = new FrameDecoder();
    expect(d.push(u8(0x01, 0x00))).toEqual([]);
    expectError(() => d.push(u8(0x00, 0x01)), LengthPrefixedFrameError, 'frameTooLarge');
    expect(d.hasIncompleteFrame).toBe(false);
  });
});
