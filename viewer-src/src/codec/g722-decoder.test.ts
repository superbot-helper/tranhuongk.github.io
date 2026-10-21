import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { MAX_ENCODED_PACKET_BYTES } from '../proto/audio-message';
import { u8 } from '../proto/test-utils';
import { G722Decoder } from './g722-decoder';

// Windows NAudio 1.8.5 oracle, copied from MacViewer Tests/Fixtures/g722-windows.json.
interface Fixture {
  EncodedBase64: string;
  PCMBase64: string;
  SplitChunks: { EncodedOffset: number; EncodedLength: number; PCMBase64: string }[];
}
const fixtures = (
  JSON.parse(readFileSync(new URL('../../test/fixtures/g722-windows.json', import.meta.url), 'utf8')) as {
    Fixtures: Fixture[];
  }
).Fixtures;

const bytes = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));

/** Little-endian byte view of decoded samples (the Swift decoder returns Data). */
const pcmBytes = (pcm: Int16Array): Uint8Array => {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  pcm.forEach((s, i) => view.setInt16(i * 2, s, true));
  return out;
};

// Ported from G722DecoderTests.swift.
describe('G722Decoder (G722DecoderTests.swift)', () => {
  test('naudioOutputWrap: overflowing final QMF output wraps instead of saturating', async () => {
    // Encoded byte 38 produces raw QMF 37090 at sample 76: NAudio wraps to -28446, WebRTC gives 32767.
    const decoder = await G722Decoder.create();
    const pcm = decoder.decode(Uint8Array.from({ length: 39 }, (_, i) => i));
    expect(pcm.length).toBe(78);
    expect(pcm[76]).toBe(-28446);
    decoder.dispose();
  });

  test('windowsCodecFixture: one-shot and every split with a fresh decoder match NAudio byte for byte', async () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      const encoded = bytes(fixture.EncodedBase64);
      const expected = bytes(fixture.PCMBase64);
      const oneShot = await G722Decoder.create();
      expect(pcmBytes(oneShot.decode(encoded))).toEqual(expected);
      oneShot.dispose();

      const streaming = await G722Decoder.create();
      const combined: number[] = [];
      for (const chunk of fixture.SplitChunks) {
        const input = encoded.subarray(chunk.EncodedOffset, chunk.EncodedOffset + chunk.EncodedLength);
        const actual = pcmBytes(streaming.decode(input));
        expect(actual).toEqual(bytes(chunk.PCMBase64));
        combined.push(...actual);
      }
      expect(Uint8Array.from(combined)).toEqual(expected);
      streaming.dispose();
    }
  });

  test('streamState: state spans packet boundaries and empty packets do not advance it', async () => {
    const first = Uint8Array.from({ length: 256 }, (_, i) => i);
    const second = first.slice().reverse();
    const streaming = await G722Decoder.create();
    const firstPcm = streaming.decode(first);
    expect(firstPcm.length).toBe(first.length * 2);
    expect(streaming.decode(new Uint8Array()).length).toBe(0);
    const secondPcm = streaming.decode(second);
    const complete = (await G722Decoder.create()).decode(Uint8Array.from([...first, ...second]));
    expect(Int16Array.from([...firstPcm, ...secondPcm])).toEqual(complete);
    expect((await G722Decoder.create()).decode(second)).not.toEqual(secondPcm);
  });

  test('packetBound: an oversized packet rejects before changing decoder state', async () => {
    const decoder = await G722Decoder.create();
    expect(() => decoder.decode(new Uint8Array(MAX_ENCODED_PACKET_BYTES + 1))).toThrow(RangeError);
    const packet = new Uint8Array(128).fill(0x3c);
    expect(decoder.decode(packet)).toEqual((await G722Decoder.create()).decode(packet));
    // The largest accepted packet decodes to 2 samples per byte.
    expect(decoder.decode(new Uint8Array(MAX_ENCODED_PACKET_BYTES)).length).toBe(MAX_ENCODED_PACKET_BYTES * 2);
  });

  test('decode returns a copy that survives later calls and heap growth', async () => {
    const decoder = await G722Decoder.create();
    const a = decoder.decode(u8(1, 2, 3, 4));
    const snapshot = a.slice();
    decoder.decode(new Uint8Array(MAX_ENCODED_PACKET_BYTES).fill(0x55));
    expect(a).toEqual(snapshot);
  });

  test('dispose is idempotent and later use throws', async () => {
    const decoder = await G722Decoder.create();
    decoder.dispose();
    decoder.dispose();
    expect(() => decoder.decode(u8(1))).toThrow('disposed');
  });
});
