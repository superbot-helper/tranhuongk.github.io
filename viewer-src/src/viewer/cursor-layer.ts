// Remote cursor overlay. CursorPresenter ports MacViewer RemoteCursorPresenter.swift (LRU shape
// cache, duplicate-request suppression, fallback arrow, late-reply handling); CursorLayer draws
// the current shape on a canvas laid over the screen canvas at
//   position - hotspot - virtualOrigin - crop, scaled like the contain-fitted image
// (Swift RemoteScreenView.updateRemoteCursor / ConnectionModel.updateRemoteCursor). It never
// touches the real pointer: hiding the browser cursor is the page's decision (see `shapeKnown`).
import type { View } from '../input/geometry';
import { IGNORED_SELECTION_HASH, type CursorEvent } from '../proto/cursor';
import { CurDecodeError, decodeCur, decodeCurAsync, type DecodedCursor, type PngDecoder } from './cur-decode';

const MAXIMUM_SHAPES = 64;
const MAXIMUM_DECODED_BYTES = 16 * 1024 * 1024;

/** The shape part of a decoded cursor (what the cache stores and the layer draws). */
export type CursorShape = Pick<DecodedCursor, 'width' | 'height' | 'hotX' | 'hotY' | 'rgba'>;

const ARROW_ROWS = [
  '#',
  '##',
  '#.#',
  '#..#',
  '#...#',
  '#....#',
  '#.....#',
  '#......#',
  '#.......#',
  '#........#',
  '#.....#####',
  '#..#..#',
  '#.# #..#',
  '##  #..#',
  '#    #..#',
  '     #..#',
  '      #..#',
  '      #..#',
  '       ##',
];

function makeArrow(): CursorShape {
  const width = 12;
  const height = ARROW_ROWS.length;
  const rgba = new Uint8ClampedArray(width * height * 4);
  ARROW_ROWS.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== '#' && ch !== '.') return;
      const o = (y * width + x) * 4;
      const value = ch === '#' ? 0 : 255;
      rgba[o] = value;
      rgba[o + 1] = value;
      rgba[o + 2] = value;
      rgba[o + 3] = 255;
    });
  });
  return { width, height, hotX: 0, hotY: 0, rgba };
}

/** Shown while a shape is missing or undecodable (Swift: NSCursor.arrow). */
export const arrowCursor: CursorShape = makeArrow();

interface Entry {
  shape: CursorShape;
  bytes: number;
  isFallback: boolean;
}

export interface CursorSnapshot {
  shape: CursorShape;
  /** Unscaled remote virtual-desktop coordinates (may be negative), null until the first position. */
  position: { x: number; y: number } | null;
  isFallback: boolean;
}

export class CursorPresenter {
  private readonly fallback: Entry = { shape: arrowCursor, bytes: 0, isFallback: true };
  private readonly cache = new Map<number, Entry>();
  /** Least recently used first. */
  private recency: number[] = [];
  private pending = new Set<number>();
  private pendingOrder: number[] = [];
  private current: Entry = this.fallback;
  private point: { x: number; y: number } | null = null;
  private cachedBytes = 0;
  private selected: number | null = null;

  constructor(
    private readonly maximumShapes = MAXIMUM_SHAPES,
    private readonly maximumBytes = MAXIMUM_DECODED_BYTES,
  ) {
    if (!(maximumShapes >= 1 && maximumShapes <= MAXIMUM_SHAPES)) throw new RangeError('maximumShapes');
    if (!(maximumBytes >= 1 && maximumBytes <= MAXIMUM_DECODED_BYTES)) throw new RangeError('maximumBytes');
  }

  get snapshot(): CursorSnapshot {
    return { shape: this.current.shape, position: this.point, isFallback: this.current.isFallback };
  }

  get selectedHash(): number | null {
    return this.selected;
  }

  get cacheEntryCount(): number {
    return this.cache.size;
  }

  get cacheByteCount(): number {
    return this.cachedBytes;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  /**
   * Command 3. Returns the hash to request (command 4 `4|||hash`) when it is newly missing;
   * duplicates are suppressed in a bounded set. The ignored hash changes nothing.
   */
  select(hash: number): number | null {
    if (hash === IGNORED_SELECTION_HASH) return null;
    this.selected = hash;
    const hit = this.cache.get(hash);
    if (hit) {
      this.touch(hash);
      this.current = hit;
      return null;
    }
    if (this.pending.has(hash)) return null;
    while (this.pendingOrder.length >= this.maximumShapes) this.pending.delete(this.pendingOrder.shift()!);
    this.pending.add(hash);
    this.pendingOrder.push(hash);
    return hash;
  }

  /**
   * Command 4 reply. `null` = the cursor could not be decoded: the arrow is cached for that hash
   * so it is not requested again. A late reply is cached but only shown if its hash is selected.
   */
  setShape(hash: number, decoded: CursorShape | null): void {
    this.pending.delete(hash);
    this.pendingOrder = this.pendingOrder.filter((h) => h !== hash);
    let entry: Entry = this.fallback;
    if (decoded) {
      const bytes = decoded.width * decoded.height * 4;
      if (bytes <= this.maximumBytes) entry = { shape: decoded, bytes, isFallback: false };
    }
    const previous = this.cache.get(hash);
    if (previous) {
      this.cachedBytes -= previous.bytes;
      this.cache.delete(hash);
    }
    this.recency = this.recency.filter((h) => h !== hash);
    while (this.recency.length > 0 && (this.cache.size >= this.maximumShapes || entry.bytes > this.maximumBytes - this.cachedBytes)) {
      const oldest = this.recency.shift()!;
      const removed = this.cache.get(oldest);
      if (removed) this.cachedBytes -= removed.bytes;
      this.cache.delete(oldest);
    }
    this.cache.set(hash, entry);
    this.cachedBytes += entry.bytes;
    this.recency.push(hash);
    if (this.selected === hash) this.current = entry;
  }

  /** Command 28. */
  setPosition(x: number, y: number): void {
    this.point = { x, y };
  }

  /** Forget requests that may never be answered (a re-login or reconnect); the cache is kept. */
  clearPending(): void {
    this.pending.clear();
    this.pendingOrder = [];
  }

  reset(): void {
    this.cache.clear();
    this.recency = [];
    this.clearPending();
    this.cachedBytes = 0;
    this.selected = null;
    this.current = this.fallback;
    this.point = null;
  }

  private touch(hash: number): void {
    this.recency = this.recency.filter((h) => h !== hash);
    this.recency.push(hash);
  }
}

export interface Placement {
  /** CSS pixels relative to the overlay's top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where to draw the sprite, or null when the pointer hotspot is outside the displayed region
 * (another monitor) or the view is degenerate. `view` is what input/geometry.ts uses, so the
 * pointer lands where a click would.
 */
export function cursorPlacement(
  view: View,
  position: { x: number; y: number },
  shape: Pick<CursorShape, 'width' | 'height' | 'hotX' | 'hotY'>,
): Placement | null {
  const { width, height } = view.canvasRect;
  const regionW = view.crop.w > 0 ? view.crop.w : view.imageW;
  const regionH = view.crop.h > 0 ? view.crop.h : view.imageH;
  if (![width, height, regionW, regionH, position.x, position.y].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0 || regionW <= 0 || regionH <= 0) return null;
  const px = position.x - view.virtualLeft - view.crop.x;
  const py = position.y - view.virtualTop - view.crop.y;
  if (px < 0 || py < 0 || px >= regionW || py >= regionH) return null;
  const scale = Math.min(width / regionW, height / regionH);
  const offsetX = (width - regionW * scale) / 2;
  const offsetY = (height - regionH * scale) / 2;
  return {
    x: offsetX + (px - shape.hotX) * scale,
    y: offsetY + (py - shape.hotY) * scale,
    width: shape.width * scale,
    height: shape.height * scale,
  };
}

export interface CursorLayerOptions {
  /** Redraw tick; defaults to requestAnimationFrame. */
  schedule?: (cb: () => void) => void;
  /** PNG-in-CUR decoder; defaults to createImageBitmap. */
  png?: PngDecoder;
  /** Builds the drawable for a shape; defaults to a canvas. */
  createSprite?: (shape: CursorShape) => CanvasImageSource | null;
  pixelRatio?: () => number;
  /** `shapeKnown` changed. */
  onKnownChange?: (known: boolean) => void;
}

function canvasSprite(shape: CursorShape): CanvasImageSource | null {
  const canvas = document.createElement('canvas');
  canvas.width = shape.width;
  canvas.height = shape.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(shape.rgba as Uint8ClampedArray<ArrayBuffer>, shape.width, shape.height), 0, 0);
  return canvas;
}

export class CursorLayer {
  readonly presenter = new CursorPresenter();
  private readonly sprites = new WeakMap<CursorShape, CanvasImageSource | null>();
  private view: View | null = null;
  private viewKey = '';
  private visible = false;
  private known = false;
  private drawPending = false;
  private disposed = false;
  /** Bumped by reset(): async decodes started before it are dropped. */
  private generation = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly requestShape: (hash: number) => void,
    private readonly options: CursorLayerOptions = {},
  ) {
    const s = canvas.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.pointerEvents = 'none';
  }

  /**
   * True when the page may hide the browser cursor: a real (non-fallback) remote shape is
   * selected, the remote position is known, and the overlay is on.
   */
  get shapeKnown(): boolean {
    return this.visible && !this.presenter.snapshot.isFallback && this.presenter.snapshot.position !== null;
  }

  onEvent(e: CursorEvent): void {
    switch (e.type) {
      case 'select': {
        const missing = this.presenter.select(e.hash);
        if (missing !== null) this.requestShape(missing);
        break;
      }
      case 'shape':
        this.receiveShape(e.hash, e.cur);
        break;
      case 'position':
        this.presenter.setPosition(e.x, e.y);
        break;
    }
    this.changed();
  }

  /** The screen canvas box, frame size, crop and virtual origin (ScreenView.view()). */
  setView(view: View): void {
    const r = view.canvasRect;
    const key = [r.width, r.height, view.imageW, view.imageH, view.crop.x, view.crop.y, view.crop.w, view.crop.h, view.virtualLeft, view.virtualTop].join(',');
    this.view = view;
    if (key === this.viewKey) return;
    this.viewKey = key;
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.invalidate();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.changed();
  }

  /** A re-login or reconnect: shapes requested before it may never arrive. */
  clearPending(): void {
    this.presenter.clearPending();
  }

  /** Session ended: forget shapes, selection and position. */
  reset(): void {
    this.generation++;
    this.presenter.reset();
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
  }

  private receiveShape(hash: number, cur: Uint8Array): void {
    try {
      this.presenter.setShape(hash, decodeCur(cur));
      return;
    } catch (e) {
      if (!(e instanceof CurDecodeError && e.code === 'pngRequiresDecoder')) {
        this.presenter.setShape(hash, null);
        return;
      }
    }
    // PNG: the hash stays pending while it decodes, so it is not requested twice.
    const generation = this.generation;
    const install = (shape: DecodedCursor | null) => {
      if (generation !== this.generation || this.disposed) return;
      this.presenter.setShape(hash, shape);
      this.changed();
    };
    decodeCurAsync(cur, this.options.png).then(install, () => install(null));
  }

  private changed(): void {
    const known = this.shapeKnown;
    if (known !== this.known) {
      this.known = known;
      this.options.onKnownChange?.(known);
    }
    this.invalidate();
  }

  private invalidate(): void {
    if (this.drawPending || this.disposed) return;
    this.drawPending = true;
    (this.options.schedule ?? ((cb) => requestAnimationFrame(cb)))(() => {
      this.drawPending = false;
      this.draw();
    });
  }

  private draw(): void {
    if (this.disposed) return;
    const context = this.canvas.getContext('2d');
    if (!context) return;
    const view = this.view;
    const ratio = (this.options.pixelRatio ?? (() => globalThis.devicePixelRatio || 1))();
    if (view) {
      const w = Math.max(1, Math.round(view.canvasRect.width * ratio));
      const h = Math.max(1, Math.round(view.canvasRect.height * ratio));
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const { shape, position } = this.presenter.snapshot;
    if (!this.visible || !view || !position) return;
    const placement = cursorPlacement(view, position, shape);
    if (!placement) return;
    let sprite = this.sprites.get(shape);
    if (sprite === undefined) {
      sprite = (this.options.createSprite ?? canvasSprite)(shape);
      this.sprites.set(shape, sprite);
    }
    if (!sprite) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    // Pixel art stays crisp when magnified; shrinking is smoothed.
    context.imageSmoothingEnabled = placement.width < shape.width;
    context.drawImage(sprite, placement.x, placement.y, placement.width, placement.height);
  }
}
