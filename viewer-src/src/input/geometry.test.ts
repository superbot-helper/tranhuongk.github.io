import { describe, expect, test } from 'vitest';
import { toRemote } from './geometry';
import type { View } from './geometry';

function view(over: Partial<View> = {}): View {
  return {
    canvasRect: { left: 0, top: 0, width: 960, height: 540 },
    imageW: 1920,
    imageH: 1080,
    crop: { x: 0, y: 0, w: 1920, h: 1080 },
    virtualLeft: 0,
    virtualTop: 0,
    ...over,
  };
}

describe('toRemote geometry', () => {
  test('canvas scaled to half: centre click maps to image centre', () => {
    expect(toRemote(480, 270, view())).toEqual({ x: 960, y: 540 });
    expect(toRemote(0, 0, view())).toEqual({ x: 0, y: 0 });
    expect(toRemote(959.9, 539.9, view())).toEqual({ x: 1919, y: 1079 });
  });

  test('canvas offset on the page is subtracted', () => {
    const v = view({ canvasRect: { left: 100, top: 50, width: 960, height: 540 } });
    expect(toRemote(580, 320, v)).toEqual({ x: 960, y: 540 });
  });

  test('letterbox: wide canvas has side bars, tall canvas has top/bottom bars', () => {
    // 2000x540 canvas, 16:9 image => scale .5, image 960 wide centred at x offset 520.
    const wide = view({ canvasRect: { left: 0, top: 0, width: 2000, height: 540 } });
    expect(toRemote(100, 270, wide)).toBeNull(); // left bar
    expect(toRemote(1900, 270, wide)).toBeNull(); // right bar
    expect(toRemote(520, 0, wide)).toEqual({ x: 0, y: 0 });
    expect(toRemote(1000, 270, wide)).toEqual({ x: 960, y: 540 });
    // 960x1000 canvas => scale .5, image height 540 centred at y offset 230.
    const tall = view({ canvasRect: { left: 0, top: 0, width: 960, height: 1000 } });
    expect(toRemote(480, 100, tall)).toBeNull();
    expect(toRemote(480, 900, tall)).toBeNull();
    expect(toRemote(480, 500, tall)).toEqual({ x: 960, y: 540 });
  });

  test('awkward scale keeps exact centre on the centre pixel', () => {
    const v = view({ canvasRect: { left: 0, top: 0, width: 1000, height: 500 } });
    // scale 1080/... = 500/1080; centre of the canvas is the centre of the image.
    expect(toRemote(500, 250, v)).toEqual({ x: 960, y: 540 });
  });

  test('pointer outside the image is null unless a button is held, then it clamps to the edge', () => {
    const wide = view({ canvasRect: { left: 0, top: 0, width: 2000, height: 540 } });
    expect(toRemote(10, 270, wide)).toBeNull();
    expect(toRemote(10, 270, wide, true)).toEqual({ x: 0, y: 540 });
    expect(toRemote(1990, 270, wide, true)).toEqual({ x: 1919, y: 540 });
    expect(toRemote(-500, -500, view(), true)).toEqual({ x: 0, y: 0 });
    expect(toRemote(9999, 9999, view(), true)).toEqual({ x: 1919, y: 1079 });
    expect(toRemote(9999, 9999, view())).toBeNull();
  });

  test('monitor crop and negative virtualLeft: -1920:0:0:1080|0:0:1920:1080| over a 3840x1080 frame', () => {
    // Frame covers the virtual desktop starting at x = -1920. Monitor 2 is the right half.
    const monitor2 = view({
      imageW: 3840,
      imageH: 1080,
      crop: { x: 1920, y: 0, w: 1920, h: 1080 },
      virtualLeft: -1920,
      virtualTop: 0,
    });
    expect(toRemote(480, 270, monitor2)).toEqual({ x: 960, y: 540 });
    expect(toRemote(0, 0, monitor2)).toEqual({ x: 0, y: 0 });
    // Monitor 1 is the left half: remote coordinates are negative.
    const monitor1 = { ...monitor2, crop: { x: 0, y: 0, w: 1920, h: 1080 } };
    expect(toRemote(480, 270, monitor1)).toEqual({ x: -960, y: 540 });
    expect(toRemote(0, 0, monitor1)).toEqual({ x: -1920, y: 0 });
    // Whole desktop: canvas 960x270 shows the 3840x1080 frame at quarter scale.
    const all = view({ canvasRect: { left: 0, top: 0, width: 960, height: 270 }, imageW: 3840, imageH: 1080, crop: { x: 0, y: 0, w: 3840, h: 1080 }, virtualLeft: -1920 });
    expect(toRemote(240, 135, all)).toEqual({ x: -960, y: 540 });
    // A vertical virtual offset (monitor above the primary) adds the same way.
    expect(toRemote(0, 0, { ...monitor2, virtualTop: -1080 })).toEqual({ x: 0, y: -1080 });
  });

  test('result is clamped to the Int32 range', () => {
    const huge = view({ virtualLeft: 0x7fffffff, virtualTop: -0x80000000 });
    expect(toRemote(959, 539, huge)).toEqual({ x: 0x7fffffff, y: -0x80000000 + 1078 });
    expect(toRemote(0, 0, huge)).toEqual({ x: 0x7fffffff, y: -0x80000000 });
  });

  test('degenerate geometry and non-finite input give null', () => {
    expect(toRemote(1, 1, view({ canvasRect: { left: 0, top: 0, width: 0, height: 540 } }))).toBeNull();
    expect(toRemote(1, 1, view({ crop: { x: 0, y: 0, w: 0, h: 0 }, imageW: 0, imageH: 0 }))).toBeNull();
    expect(toRemote(NaN, 1, view())).toBeNull();
    expect(toRemote(1, Infinity, view(), true)).toBeNull();
  });

  test('an empty crop falls back to the whole frame', () => {
    expect(toRemote(480, 270, view({ crop: { x: 0, y: 0, w: 0, h: 0 } }))).toEqual({ x: 960, y: 540 });
  });
});
