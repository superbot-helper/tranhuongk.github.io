import { describe, expect, test } from 'vitest';
import { createFrameScheduler, LatestScreenFrame } from './latest-frame';

describe('LatestScreenFrame (LatestScreenFrameTests.swift)', () => {
  test('frames arriving before the consumer takes one are announced once and only the newest is kept', () => {
    const latest = new LatestScreenFrame<number>();
    expect(latest.put(1)).toBe(true);
    expect(latest.put(2)).toBe(false);
    expect(latest.put(3)).toBe(false);
    expect(latest.take()).toBe(3);
    expect(latest.take()).toBeNull();
    expect(latest.put(4)).toBe(true);
    expect(latest.take()).toBe(4);
  });

  test('a flood of frames uses one announcement slot, so a later control event still fits', () => {
    const latest = new LatestScreenFrame<number>();
    const queue: string[] = [];
    for (let value = 0; value < 1000; value++) if (latest.put(value)) queue.push('frame');
    queue.push('chat');
    expect(queue).toEqual(['frame', 'chat']);
    expect(latest.take()).toBe(999);
  });
});

describe('createFrameScheduler', () => {
  test('several frames before the animation tick produce one draw of the newest', () => {
    const ticks: (() => void)[] = [];
    const drawn: number[] = [];
    const s = createFrameScheduler<number>((f) => drawn.push(f), (cb) => ticks.push(cb));
    s.push(1);
    s.push(2);
    s.push(3);
    expect(ticks).toHaveLength(1);
    ticks.shift()!();
    expect(drawn).toEqual([3]);
    s.push(4);
    expect(ticks).toHaveLength(1);
    ticks.shift()!();
    expect(drawn).toEqual([3, 4]);
  });

  test('clear() drops the pending frame; the scheduled tick draws nothing and the next push reschedules', () => {
    const ticks: (() => void)[] = [];
    const drawn: number[] = [];
    const s = createFrameScheduler<number>((f) => drawn.push(f), (cb) => ticks.push(cb));
    s.push(1);
    s.clear();
    ticks.shift()!();
    expect(drawn).toEqual([]);
    s.push(2);
    ticks.shift()!();
    expect(drawn).toEqual([2]);
  });
});
