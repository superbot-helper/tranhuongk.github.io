import { describe, expect, test } from 'vitest';
import { MAX_AUDIO_QUEUE_FRAMES, emptyQueue, enqueue, render, silenceFrames } from './audio-queue';

/** Interleaved stereo ramp: frame n = (start + n, -(start + n)). */
function frames(count: number, start = 0): Int16Array {
  const pcm = new Int16Array(count * 2);
  for (let i = 0; i < count; i++) {
    pcm[i * 2] = start + i;
    pcm[i * 2 + 1] = -(start + i);
  }
  return pcm;
}

describe('enqueue (RemoteAudioPlayer.play queue rules)', () => {
  test('cap is 12000 frames, 250 ms at 48 kHz', () => {
    expect(MAX_AUDIO_QUEUE_FRAMES).toBe(12_000);
  });

  test('appends while the total stays within the cap (exactly the cap fits)', () => {
    let s = enqueue(emptyQueue(), frames(8000));
    s = enqueue(s, frames(4000, 8000));
    expect(s.frames).toBe(12_000);
    expect(s.chunks).toHaveLength(2);
  });

  test('exceeding the cap drops everything queued, then enqueues the new packet', () => {
    let s = enqueue(emptyQueue(), frames(8000));
    s = enqueue(s, frames(4001, 20_000));
    expect(s.frames).toBe(4001);
    expect(s.chunks).toHaveLength(1);
    expect(s.chunks[0]![0]).toBe(20_000);
  });

  test('a single packet above the cap keeps only its newest 12000 frames', () => {
    const s = enqueue(emptyQueue(), frames(20_000));
    expect(s.frames).toBe(12_000);
    expect(s.chunks[0]!.length).toBe(24_000);
    expect(s.chunks[0]![0]).toBe(8000);
    expect(s.chunks[0]![1]).toBe(-8000);
    expect(s.chunks[0]![23_998]).toBe(19_999);
  });

  test('an oversize packet also drops the existing backlog', () => {
    const s = enqueue(enqueue(emptyQueue(), frames(100)), frames(13_000, 500));
    expect(s.frames).toBe(12_000);
    expect(s.chunks).toHaveLength(1);
    expect(s.chunks[0]![0]).toBe(1500);
  });

  test('empty and odd-length input is ignored / truncated to whole frames', () => {
    expect(enqueue(emptyQueue(), new Int16Array()).frames).toBe(0);
    expect(enqueue(emptyQueue(), new Int16Array(5)).frames).toBe(2);
  });

  test('does not mutate the previous state', () => {
    const before = enqueue(emptyQueue(), frames(10));
    enqueue(before, frames(10));
    expect(before.frames).toBe(10);
    expect(before.chunks).toHaveLength(1);
  });

  test('silence of N PCM bytes is N/4 zero frames (and obeys the cap)', () => {
    expect(silenceFrames(19_200)).toEqual(new Int16Array(9600));
    expect(silenceFrames(0)).toEqual(new Int16Array(0));
    expect(enqueue(emptyQueue(), silenceFrames(262_144)).frames).toBe(12_000);
    const s = enqueue(enqueue(emptyQueue(), frames(4)), silenceFrames(16));
    expect(s.frames).toBe(8);
    expect(Array.from(s.chunks[1]!)).toEqual(new Array(8).fill(0));
  });
});

describe('render', () => {
  test('1:1 plays Int16 as Float32 /32768 to L and R, across chunk boundaries', () => {
    let s = enqueue(emptyQueue(), Int16Array.of(16384, -16384, 32767, -32768));
    s = enqueue(s, Int16Array.of(0, 8192));
    const l = new Float32Array(4);
    const r = new Float32Array(4);
    s = render(s, l, r, 1);
    expect(Array.from(l)).toEqual([0.5, 32767 / 32768, 0, 0]);
    expect(Array.from(r)).toEqual([-0.5, -1, 0.25, 0]);
    expect(s.frames).toBe(0);
  });

  test('underrun outputs silence and keeps what remains for the next call', () => {
    let s = enqueue(emptyQueue(), frames(3, 1));
    const l = new Float32Array(2);
    const r = new Float32Array(2);
    s = render(s, l, r, 1);
    expect(s.frames).toBe(1);
    s = render(s, l, r, 1);
    expect(l[0]).toBeCloseTo(3 / 32768);
    expect(l[1]).toBe(0);
    expect(s.frames).toBe(0);
  });

  test('linear resampling: 48 kHz material on a 96 kHz context interpolates', () => {
    let s = enqueue(emptyQueue(), Int16Array.of(0, 0, 3277, 3277, 6554, 6554, 9830, 9830));
    const l = new Float32Array(6);
    const r = new Float32Array(6);
    s = render(s, l, r, 0.5);
    const expected = [0, 1638.5, 3277, 4915.5, 6554, 8192].map((v) => v / 32768);
    expected.forEach((v, i) => expect(l[i]).toBeCloseTo(v, 6));
    expect(r[1]).toBeCloseTo(1638.5 / 32768, 6);
  });

  test('resampling continues across calls without a seam', () => {
    const src = frames(20, 1);
    const whole = new Float32Array(12);
    render(enqueue(emptyQueue(), src), whole, new Float32Array(12), 0.5);
    let s = enqueue(emptyQueue(), src);
    const a = new Float32Array(5);
    const b = new Float32Array(7);
    s = render(s, a, new Float32Array(5), 0.5);
    render(s, b, new Float32Array(7), 0.5);
    expect(Array.from([...a, ...b])).toEqual(Array.from(whole));
  });

  test('downsampling (44.1 kHz context) consumes proportionally', () => {
    const s = render(enqueue(emptyQueue(), frames(100)), new Float32Array(10), new Float32Array(10), 48_000 / 44_100);
    expect(s.frames).toBeGreaterThan(85);
    expect(s.frames).toBeLessThan(100);
  });
});
