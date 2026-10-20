import { describe, expect, test, vi } from 'vitest';
import type { View } from '../input/geometry';
import { IGNORED_SELECTION_HASH } from '../proto/cursor';
import { decodeCur, decodeCurAsync, type DecodedCursor, type PngDecoder } from './cur-decode';
import { curFile, dib, pngStub } from './cur-test-utils';
import { arrowCursor, CursorLayer, CursorPresenter, cursorPlacement, type CursorLayerOptions } from './cursor-layer';

// Presenter tests port MacViewerTests/RemoteCursorPresenterTests.swift; the layer tests cover
// the page-side parts (request-once, async PNG, placement, redraw coalescing).

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** 2x2 opaque shape with a 16-byte decoded size (Swift pngFixture(2x2)). */
function shape2x2(hotX = 0, hotY = 0): DecodedCursor {
  return { width: 2, height: 2, hotX, hotY, rgba: new Uint8ClampedArray(16).fill(255) };
}

const png2x2: PngDecoder = async () => ({ width: 2, height: 2, rgba: new Uint8ClampedArray(16).fill(255) });

describe('CursorPresenter (port of RemoteCursorPresenter)', () => {
  test('missing selection requests are suppressed and the position stays in virtual coordinates', () => {
    const p = new CursorPresenter();
    expect(p.snapshot.isFallback).toBe(true);
    expect(p.select(-17)).toBe(-17);
    expect(p.select(-17)).toBeNull();
    expect(p.pendingRequestCount).toBe(1);
    p.setPosition(-1920, 32767);
    expect(p.snapshot.position).toEqual({ x: -1920, y: 32767 });
    expect(p.select(IGNORED_SELECTION_HASH)).toBeNull();
    expect(p.selectedHash).toBe(-17);
    expect(p.pendingRequestCount).toBe(1);
  });

  test('a shape for the selected hash is shown with its hotspot and cached', () => {
    const p = new CursorPresenter();
    expect(p.select(5)).toBe(5);
    p.setPosition(-20, 10);
    p.setShape(5, shape2x2(1, 1));
    expect(p.snapshot.isFallback).toBe(false);
    expect([p.snapshot.shape.width, p.snapshot.shape.height, p.snapshot.shape.hotX, p.snapshot.shape.hotY]).toEqual([2, 2, 1, 1]);
    expect(p.snapshot.position).toEqual({ x: -20, y: 10 });
    expect(p.cacheEntryCount).toBe(1);
    expect(p.cacheByteCount).toBe(16);
    expect(p.pendingRequestCount).toBe(0);
    expect(p.select(5)).toBeNull();
  });

  test('late shape replies do not replace the newly selected cursor', () => {
    const p = new CursorPresenter();
    p.select(1);
    p.select(2);
    p.setShape(1, shape2x2(0, 0));
    expect(p.snapshot.isFallback).toBe(true);
    expect(p.selectedHash).toBe(2);
    p.setShape(2, shape2x2(1, 1));
    expect(p.snapshot.isFallback).toBe(false);
    expect(p.snapshot.shape.hotX).toBe(1);
    expect(p.select(1)).toBeNull();
    expect(p.snapshot.shape.hotX).toBe(0);
  });

  test('shape-count and byte budgets evict the least recently selected entries', () => {
    const p = new CursorPresenter(2, 32);
    p.setShape(1, shape2x2());
    p.setShape(2, shape2x2());
    p.select(1);
    p.setShape(3, shape2x2());
    expect(p.cacheEntryCount).toBe(2);
    expect(p.cacheByteCount).toBe(32);
    expect(p.select(2)).toBe(2);
    expect(p.select(2)).toBeNull();
    const byteLimited = new CursorPresenter(64, 16);
    byteLimited.setShape(1, shape2x2());
    byteLimited.setShape(2, shape2x2());
    expect(byteLimited.cacheEntryCount).toBe(1);
    expect(byteLimited.cacheByteCount).toBe(16);
    expect(byteLimited.select(1)).toBe(1);
  });

  test('defaults are 64 shapes and 16 MiB', () => {
    const p = new CursorPresenter();
    for (let i = 0; i < 100; i++) p.setShape(i, shape2x2());
    expect(p.cacheEntryCount).toBe(64);
    const big: DecodedCursor = { width: 256, height: 256, hotX: 0, hotY: 0, rgba: new Uint8ClampedArray(256 * 256 * 4) };
    const q = new CursorPresenter();
    for (let i = 0; i < 100; i++) q.setShape(i, big);
    expect(q.cacheByteCount).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(q.cacheEntryCount).toBe(64); // 64 x 256 KiB = 16 MiB exactly
  });

  test('pending hashes and reset are bounded across sessions', () => {
    const p = new CursorPresenter();
    for (let hash = 0; hash < 100; hash++) expect(p.select(hash)).toBe(hash);
    expect(p.pendingRequestCount).toBe(64);
    p.setShape(99, shape2x2());
    p.setPosition(100, -100);
    p.reset();
    expect(p.cacheEntryCount).toBe(0);
    expect(p.cacheByteCount).toBe(0);
    expect(p.pendingRequestCount).toBe(0);
    expect(p.selectedHash).toBeNull();
    expect(p.snapshot.isFallback).toBe(true);
    expect(p.snapshot.position).toBeNull();
    expect(p.select(99)).toBe(99);
  });

  test('a fallback shape (undecodable cursor) is cached with zero bytes and never re-requested', () => {
    const p = new CursorPresenter();
    p.select(3);
    p.setShape(3, null);
    expect(p.snapshot.isFallback).toBe(true);
    expect(p.cacheByteCount).toBe(0);
    expect(p.select(3)).toBeNull();
  });

  test('a decoded shape over the byte budget becomes the fallback', () => {
    const p = new CursorPresenter(64, 8);
    p.select(1);
    p.setShape(1, shape2x2());
    expect(p.snapshot.isFallback).toBe(true);
    expect(p.cacheByteCount).toBe(0);
  });

  test('the fallback arrow is a valid opaque-edged sprite', () => {
    expect(arrowCursor.rgba.length).toBe(arrowCursor.width * arrowCursor.height * 4);
    expect(arrowCursor.rgba.some((v, i) => i % 4 === 3 && v === 255)).toBe(true);
    expect(arrowCursor.hotX).toBeLessThan(arrowCursor.width);
  });
});

describe('cursorPlacement', () => {
  const view = (over: Partial<View> = {}): View => ({
    canvasRect: { left: 10, top: 20, width: 960, height: 540 },
    imageW: 3840,
    imageH: 1080,
    crop: { x: 0, y: 0, w: 1920, h: 1080 },
    virtualLeft: -1920,
    virtualTop: 0,
    ...over,
  });

  test('negative virtual coordinates with a monitor crop land at position - hotspot - virtual - crop, scaled', () => {
    // Monitor 1 (left of the primary): crop x 0..1920; remote x=-1000 -> decoded x 920 -> 460 css px.
    const r = cursorPlacement(view(), { x: -1000, y: 100 }, { width: 32, height: 32, hotX: 2, hotY: 3 });
    expect(r).toEqual({ x: (920 - 2) * 0.5, y: (100 - 3) * 0.5, width: 16, height: 16 });
    // Monitor 2: crop x 1920..3840 shifts it; x=-1000 is on the other monitor and hidden.
    const m2 = view({ crop: { x: 1920, y: 0, w: 1920, h: 1080 } });
    expect(cursorPlacement(m2, { x: -1000, y: 100 }, { width: 32, height: 32, hotX: 0, hotY: 0 })).toBeNull();
    expect(cursorPlacement(m2, { x: 100, y: 100 }, { width: 32, height: 32, hotX: 0, hotY: 0 })).toEqual({ x: 50, y: 50, width: 16, height: 16 });
  });

  test('whole desktop: x = pos - virtualLeft, letterboxed and centred', () => {
    const v = view({ canvasRect: { left: 0, top: 0, width: 1000, height: 600 }, crop: { x: 0, y: 0, w: 3840, h: 1080 } });
    const scale = 1000 / 3840;
    const offsetY = (600 - 1080 * scale) / 2;
    const r = cursorPlacement(v, { x: 0, y: 540 }, { width: 10, height: 10, hotX: 0, hotY: 0 })!;
    expect(r.x).toBeCloseTo(1920 * scale);
    expect(r.y).toBeCloseTo(offsetY + 540 * scale);
    expect(r.width).toBeCloseTo(10 * scale);
  });

  test('actual size: 1 remote pixel per css pixel', () => {
    const v = view({ canvasRect: { left: -300, top: -50, width: 1920, height: 1080 } });
    expect(cursorPlacement(v, { x: -1920, y: 0 }, { width: 8, height: 8, hotX: 1, hotY: 1 })).toEqual({ x: -1, y: -1, width: 8, height: 8 });
  });

  test('outside the displayed region, or a degenerate view, hides the cursor', () => {
    const edge = { width: 4, height: 4, hotX: 0, hotY: 0 };
    expect(cursorPlacement(view(), { x: -1921, y: 0 }, edge)).toBeNull();
    expect(cursorPlacement(view(), { x: -1, y: 0 }, edge)).not.toBeNull();
    expect(cursorPlacement(view(), { x: 0, y: 0 }, edge)).toBeNull(); // decoded x 1920 is past the crop
    expect(cursorPlacement(view(), { x: -1000, y: 1080 }, edge)).toBeNull();
    expect(cursorPlacement(view({ canvasRect: { left: 0, top: 0, width: 0, height: 0 } }), { x: -1000, y: 5 }, edge)).toBeNull();
  });
});

interface FakeCanvas {
  canvas: HTMLCanvasElement;
  draws: Array<{ sprite: unknown; x: number; y: number; w: number; h: number }>;
  clears: number;
  transforms: number[][];
}

function fakeCanvas(): FakeCanvas {
  const state: FakeCanvas = { canvas: null as never, draws: [], clears: 0, transforms: [] };
  const context = {
    imageSmoothingEnabled: true,
    setTransform: (...a: number[]) => state.transforms.push(a),
    clearRect: () => state.clears++,
    drawImage: (sprite: unknown, x: number, y: number, w: number, h: number) => state.draws.push({ sprite, x, y, w, h }),
  };
  state.canvas = { width: 0, height: 0, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
  return state;
}

const VIEW: View = {
  canvasRect: { left: 0, top: 0, width: 960, height: 540 },
  imageW: 1920,
  imageH: 1080,
  crop: { x: 0, y: 0, w: 1920, h: 1080 },
  virtualLeft: 0,
  virtualTop: 0,
};

function layerSetup(options: CursorLayerOptions = {}) {
  const fake = fakeCanvas();
  const requested: number[] = [];
  const ticks: Array<() => void> = [];
  const layer = new CursorLayer(fake.canvas, (h) => requested.push(h), {
    schedule: (cb) => ticks.push(cb),
    createSprite: (c) => ({ sprite: `${c.width}x${c.height}` }) as unknown as CanvasImageSource,
    pixelRatio: () => 1,
    png: png2x2,
    ...options,
  });
  const frame = () => ticks.splice(0).forEach((cb) => cb());
  return { fake, layer, requested, ticks, frame };
}

const dibFile = (hotX = 0) => curFile(dib({ width: 2, height: 2, bits: 32, pixelRows: new Array<number>(16).fill(255), maskRows: new Array<number>(8).fill(0) }), 2, 2, hotX, 0);

describe('CursorLayer', () => {
  test('requests an unknown shape exactly once until it arrives, then serves it from the cache', async () => {
    const { layer, requested } = layerSetup();
    layer.onEvent({ type: 'select', hash: 7 });
    layer.onEvent({ type: 'select', hash: 7 });
    layer.onEvent({ type: 'select', hash: 7 });
    expect(requested).toEqual([7]);
    layer.onEvent({ type: 'shape', hash: 7, cur: dibFile() });
    await flush();
    layer.onEvent({ type: 'select', hash: 8 });
    layer.onEvent({ type: 'select', hash: 7 });
    expect(requested).toEqual([7, 8]);
    expect(layer.presenter.snapshot.isFallback).toBe(false);
  });

  test('the ignored selection hash is never requested', () => {
    const { layer, requested } = layerSetup();
    layer.onEvent({ type: 'select', hash: IGNORED_SELECTION_HASH });
    expect(requested).toEqual([]);
  });

  test('clearPending lets a shape that never arrived be requested again after a reconnect', () => {
    const { layer, requested } = layerSetup();
    layer.onEvent({ type: 'select', hash: 7 });
    layer.clearPending();
    layer.onEvent({ type: 'select', hash: 7 });
    expect(requested).toEqual([7, 7]);
  });

  test('reset forgets cache and selection', async () => {
    const { layer, requested } = layerSetup();
    layer.onEvent({ type: 'select', hash: 7 });
    layer.onEvent({ type: 'shape', hash: 7, cur: dibFile() });
    layer.reset();
    layer.onEvent({ type: 'select', hash: 7 });
    expect(requested).toEqual([7, 7]);
    expect(layer.presenter.snapshot.isFallback).toBe(true);
  });

  test('a PNG shape is decoded asynchronously; no duplicate request meanwhile; hotspot validated', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const png: PngDecoder = async (b) => {
      await gate;
      return png2x2(b);
    };
    const { layer, requested } = layerSetup({ png });
    layer.onEvent({ type: 'select', hash: 9 });
    layer.onEvent({ type: 'shape', hash: 9, cur: curFile(pngStub(2, 2), 2, 2, 1, 1) });
    layer.onEvent({ type: 'select', hash: 9 });
    expect(requested).toEqual([9]);
    expect(layer.presenter.snapshot.isFallback).toBe(true);
    release();
    await flush();
    expect(layer.presenter.snapshot.isFallback).toBe(false);
    expect([layer.presenter.snapshot.shape.hotX, layer.presenter.snapshot.shape.hotY]).toEqual([1, 1]);
  });

  test('a PNG decoded after reset is discarded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { layer } = layerSetup({ png: async (b) => (await gate, png2x2(b)) });
    layer.onEvent({ type: 'select', hash: 9 });
    layer.onEvent({ type: 'shape', hash: 9, cur: curFile(pngStub(2, 2), 2, 2) });
    layer.reset();
    release();
    await flush();
    expect(layer.presenter.cacheEntryCount).toBe(0);
  });

  test('oversized PNG, bad DIB and unknown resources fall back to the arrow without caching bytes', async () => {
    const { layer, requested } = layerSetup();
    const cases = [
      curFile(pngStub(257, 1), 256, 1),
      curFile([...dib({ width: 4096, height: 2, bits: 32, pixelRows: [], maskRows: [] })], 2, 2),
      curFile([0xaa, 0xbb, 0xcc, 0xdd], 2, 2),
      Uint8Array.of(1, 2, 3),
    ];
    for (const [i, cur] of cases.entries()) {
      layer.onEvent({ type: 'select', hash: i });
      layer.onEvent({ type: 'shape', hash: i, cur });
      await flush();
      expect(layer.presenter.snapshot.isFallback).toBe(true);
      expect(layer.presenter.cacheByteCount).toBe(0);
    }
    layer.onEvent({ type: 'select', hash: 3 });
    expect(requested).toEqual([0, 1, 2, 3]);
  });

  test('draws the remote pointer on the overlay at position - hotspot, scaled to the image rect', async () => {
    const { layer, fake, frame } = layerSetup();
    layer.setVisible(true);
    layer.setView(VIEW);
    layer.onEvent({ type: 'select', hash: 1 });
    layer.onEvent({ type: 'shape', hash: 1, cur: dibFile(1) });
    await flush();
    layer.onEvent({ type: 'position', x: 200, y: 100 });
    frame();
    expect(fake.canvas.style.width).toBe('960px');
    expect(fake.canvas.style.height).toBe('540px');
    expect(fake.canvas.style.pointerEvents).toBe('none');
    expect(fake.canvas.style.position).toBe('absolute');
    expect(fake.draws.at(-1)).toEqual({ sprite: { sprite: '2x2' }, x: (200 - 1) * 0.5, y: 50, w: 1, h: 1 });
  });

  test('coalesces redraws to one per animation frame and tracks view changes', async () => {
    const { layer, fake, ticks, frame } = layerSetup();
    layer.setVisible(true);
    layer.setView(VIEW);
    layer.onEvent({ type: 'position', x: 10, y: 10 });
    layer.onEvent({ type: 'position', x: 20, y: 20 });
    layer.onEvent({ type: 'position', x: 30, y: 30 });
    expect(ticks).toHaveLength(1);
    frame();
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0]!.x).toBe(15);
    // Same view again: nothing to redraw. A changed view (monitor crop) redraws.
    layer.setView({ ...VIEW, canvasRect: { ...VIEW.canvasRect } });
    expect(ticks).toHaveLength(0);
    layer.setView({ ...VIEW, canvasRect: { left: 0, top: 0, width: 1920, height: 1080 } });
    frame();
    expect(fake.draws).toHaveLength(2);
    expect(fake.draws[1]!.x).toBe(30);
  });

  test('hides when invisible or when the pointer is off the displayed monitor', () => {
    const { layer, fake, frame } = layerSetup();
    layer.setView({ ...VIEW, imageW: 3840, crop: { x: 1920, y: 0, w: 1920, h: 1080 }, virtualLeft: -1920 });
    layer.onEvent({ type: 'position', x: -1000, y: 100 });
    layer.setVisible(true);
    frame();
    expect(fake.draws).toHaveLength(0);
    expect(fake.clears).toBeGreaterThan(0);
    layer.onEvent({ type: 'position', x: 100, y: 100 });
    frame();
    expect(fake.draws).toHaveLength(1);
    layer.setVisible(false);
    frame();
    expect(fake.draws).toHaveLength(1);
  });

  test('scales the backing store by the device pixel ratio', () => {
    const { layer, fake, frame } = layerSetup({ pixelRatio: () => 2 });
    layer.setVisible(true);
    layer.setView(VIEW);
    layer.onEvent({ type: 'position', x: 100, y: 100 });
    frame();
    expect([fake.canvas.width, fake.canvas.height]).toEqual([1920, 1080]);
    expect(fake.transforms.at(-1)).toEqual([2, 0, 0, 2, 0, 0]);
  });

  test('reports when the local cursor can be replaced by a known remote shape', async () => {
    const known = vi.fn();
    const { layer } = layerSetup({ onKnownChange: known });
    layer.setVisible(true);
    layer.onEvent({ type: 'position', x: 1, y: 1 });
    expect(layer.shapeKnown).toBe(false);
    layer.onEvent({ type: 'select', hash: 1 });
    expect(layer.shapeKnown).toBe(false); // still waiting: fallback arrow only
    layer.onEvent({ type: 'shape', hash: 1, cur: dibFile() });
    await flush();
    expect(layer.shapeKnown).toBe(true);
    expect(known).toHaveBeenLastCalledWith(true);
    layer.setVisible(false);
    expect(known).toHaveBeenLastCalledWith(false);
    layer.setVisible(true);
    layer.reset();
    expect(known).toHaveBeenLastCalledWith(false);
    expect(known).toHaveBeenCalledTimes(4);
  });

  test('works without a 2d context', () => {
    const { layer, fake, frame } = layerSetup();
    (fake.canvas as unknown as { getContext: () => null }).getContext = () => null;
    layer.setVisible(true);
    layer.setView(VIEW);
    layer.onEvent({ type: 'position', x: 1, y: 1 });
    expect(() => frame()).not.toThrow();
  });

  test('decode helpers agree with what the layer decodes', async () => {
    const file = dibFile();
    expect(decodeCur(file).rgba).toEqual((await decodeCurAsync(file)).rgba);
  });
});
