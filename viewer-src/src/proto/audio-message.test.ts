import { describe, expect, test } from 'vitest';
import {
  AudioMessageError,
  MAX_ENCODED_PACKET_BYTES,
  MAX_PCM_PACKET_BYTES,
  decodeAudioMessage,
} from './audio-message';
import { expectError, u8 } from './test-utils';

const audioError = (fn: () => unknown, code: string): void => expectError(fn, AudioMessageError, code);

// Ported from the "audioMessages" test in G722DecoderTests.swift.
describe('computer audio message (G722DecoderTests.swift audioMessages)', () => {
  test('audio multipart distinguishes raw G722 from a signed zero-PCM count', () => {
    const encoded = u8(0, 0xff, 0x80, 42, 43);
    expect(decodeAudioMessage([u8(43), encoded])).toEqual({ type: 'g722', data: encoded });
    expect(decodeAudioMessage([u8(42), u8(0x00, 0x4b, 0, 0)])).toEqual({ type: 'silence', bytes: 19_200 });
    audioError(() => decodeAudioMessage([u8(42), new Uint8Array(4).fill(0xff)]), 'invalidSilenceLength');
    audioError(() => decodeAudioMessage([u8(42), u8(0, 0, 0)]), 'malformedMessage');
    audioError(() => decodeAudioMessage([u8(41), new Uint8Array()]), 'unsupportedCommand');
  });
});

// Extra coverage of the Swift bounds the original test does not pin down.
describe('computer audio message (port extras)', () => {
  test('constants match G722Decoder.swift', () => {
    expect(MAX_ENCODED_PACKET_BYTES).toBe(65_536);
    expect(MAX_PCM_PACKET_BYTES).toBe(262_144);
  });

  test('fewer than two parts or an empty command part is malformed', () => {
    audioError(() => decodeAudioMessage([]), 'malformedMessage');
    audioError(() => decodeAudioMessage([u8(43)]), 'malformedMessage');
    audioError(() => decodeAudioMessage([new Uint8Array(), u8(1)]), 'malformedMessage');
  });

  test('encoded packets are capped at 64 KiB and the parts at 256 KiB in total', () => {
    const max = new Uint8Array(MAX_ENCODED_PACKET_BYTES);
    expect(decodeAudioMessage([u8(43), max])).toEqual({ type: 'g722', data: max });
    audioError(() => decodeAudioMessage([u8(43), new Uint8Array(MAX_ENCODED_PACKET_BYTES + 1)]), 'packetTooLarge');
    audioError(() => decodeAudioMessage([u8(43), max, new Uint8Array(MAX_PCM_PACKET_BYTES)]), 'packetTooLarge');
    audioError(() => decodeAudioMessage([u8(42), new Uint8Array(MAX_PCM_PACKET_BYTES + 1)]), 'packetTooLarge');
  });

  test('silence counts are signed Int32 in 0..262144', () => {
    const count = (n: number): Uint8Array => u8(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    expect(decodeAudioMessage([u8(42), count(0)])).toEqual({ type: 'silence', bytes: 0 });
    expect(decodeAudioMessage([u8(42), count(MAX_PCM_PACKET_BYTES)])).toEqual({ type: 'silence', bytes: MAX_PCM_PACKET_BYTES });
    audioError(() => decodeAudioMessage([u8(42), count(MAX_PCM_PACKET_BYTES + 1)]), 'invalidSilenceLength');
    audioError(() => decodeAudioMessage([u8(42), count(-1)]), 'invalidSilenceLength');
    audioError(() => decodeAudioMessage([u8(42), count(0x80000000)]), 'invalidSilenceLength');
  });

  test('extra bytes after the Int32 silence count are ignored', () => {
    expect(decodeAudioMessage([u8(42), u8(4, 0, 0, 0, 9, 9)])).toEqual({ type: 'silence', bytes: 4 });
  });
});
