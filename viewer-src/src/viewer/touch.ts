// Touch control for phones and tablets: TRACKPAD mode for `pointerType === 'touch'` only (a real
// mouse or pen, e.g. on an iPad, keeps the desktop path in input.ts).
//
//   one finger drag ............ relative move of the remote pointer (mild acceleration, below)
//   quick tap (< 200 ms, < 10 px) left click at the remote pointer, sent once the double-tap
//                                window (250 ms) has passed without a second touch
//   tap, then touch and drag ... left drag (down, moves, up) - the first tap's click is dropped,
//                                so Windows never sees click + press (a double-click: maximize...)
//   tap, tap ................... double click (two clicks, sent at the second tap)
//   two-finger quick tap ....... right click at the remote pointer
//   two-finger vertical drag ... wheel (natural direction: fingers down = content down = scroll up)
//   pinch ...................... LOCAL zoom of the screen view (1x-4x), nothing is sent
//   two-finger drag when zoomed  LOCAL pan, nothing is sent
//
// The remote pointer is tracked in remote pixels of the current crop (floats, clamped to the
// crop) and converted to wire coordinates like the desktop path: floor + crop + virtual origin.
// Acceleration (per pointermove, i.e. per frame since browsers coalesce moves per frame), with
// d = finger travel of the event in CSS px:
//   factor 1 for d <= 4, 2.5 for d >= 20, linear in between;
//   remote delta = css delta * factor / view scale (CSS px per remote px, zoom included), so at
//   factor 1 the pointer follows the finger's on-screen distance.
import type { PointerButton } from '../input/encoder';
import type { View } from '../input/geometry';

export interface Point {
  x: number;
  y: number;
}

export interface TouchHandlers {
  /** Remote pointer moved (wire coordinates). */
  move(p: Point): void;
  down(button: PointerButton, p: Point): void;
  up(button: PointerButton, p: Point): void;
  /** Wheel in CSS pixels, WheelEvent convention (positive = scroll down). */
  wheel(deltaY: number): void;
  /** Local view zoom to the absolute `scale` (1-4) about a client point. */
  zoom(scale: number, center: Point): void;
  /** The floating ⌨ button. */
  showKeyboard(): void;
  /** Local pan of the zoomed view, CSS px. */
  pan?(dx: number, dy: number): void;
  /** Current local zoom (defaults to the last value given to `zoom`). */
  zoomScale?(): number;
  /** The floating "Phím" button. */
  specialKeys?(): void;
  /** The floating "Dán" button: paste this device's clipboard to Windows (runs inside the click). */
  pasteLocal?(): void;
  /** Touches ended abnormally (pointercancel): release everything held. */
  cancel?(): void;
  /** Control is active; when false only zoom and pan work. */
  enabled?(): boolean;
  /** Last host-reported remote pointer (wire coordinates), adopted when the trackpad is idle. */
  remotePosition?(): Point | null;
}

export interface TouchOptions {
  now?: () => number;
}

export interface TouchHandle {
  /** Remove the listeners and the floating buttons. */
  detach(): void;
  /**
   * Forget every finger, the gesture in progress and a waiting tap click, sending nothing (for an
   * abnormal end - page hidden, window blurred, session closed - where no pointerup/pointercancel
   * will come; releasing held buttons is the caller's job: DesktopInput.releaseAll).
   */
  reset(): void;
}

export const TAP_MS = 200;
export const TAP_SLOP_PX = 10;
export const DOUBLE_TAP_MS = 250;
/** Two fingers rarely land and lift together: a little more time than a one-finger tap. */
export const TWO_FINGER_TAP_MS = 300;
/** Change of the distance between two fingers that makes their gesture a pinch. */
export const PINCH_SLOP_PX = 24;
/** After this long without trackpad input the host-reported pointer position is adopted. */
export const ADOPT_HOST_AFTER_MS = 1000;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** Pointer acceleration factor for `distance` CSS px travelled in one pointermove. */
export function acceleration(distance: number): number {
  if (distance <= 4) return 1;
  if (distance >= 20) return 2.5;
  return 1 + (1.5 * (distance - 4)) / 16;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

interface Region {
  w: number;
  h: number;
  key: string;
}

function regionOf(v: View): Region | null {
  const w = v.crop.w > 0 ? v.crop.w : v.imageW;
  const h = v.crop.h > 0 ? v.crop.h : v.imageH;
  if (!(w > 0 && h > 0)) return null;
  return { w, h, key: [v.crop.x, v.crop.y, w, h, v.virtualLeft, v.virtualTop].join(',') };
}

/** CSS px per remote px of the displayed (contain-fitted, zoomed) image. */
function displayScale(v: View, r: Region): number {
  const s = Math.min(v.canvasRect.width / r.w, v.canvasRect.height / r.h);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

type Mode =
  | 'pending' // one finger, still a tap candidate
  | 'move'
  | 'drag' // left button held
  | 'idle' // one finger without control, or the rest of an ended two-finger gesture
  | 'pending2' // two fingers, still a tap candidate
  | 'scroll'
  | 'pinch'
  | 'pan'
  | 'cancelled';

interface Finger {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

interface Gesture {
  start: number;
  mode: Mode;
  maxFingers: number;
  /** A tap's click was waiting when this touch began (tap-tap: drag or double click). */
  afterTap: boolean;
  control: boolean;
  /** Two-finger state. */
  d0: number;
  c0: Point;
  prevC: Point;
  startScale: number;
}

export function attachTouch(
  el: HTMLElement,
  h: TouchHandlers,
  getView: () => View,
  o: TouchOptions = {},
): TouchHandle {
  const now = o.now ?? (() => performance.now());
  const fingers = new Map<number, Finger>();
  let gesture: Gesture | null = null;
  let pendingClick: ReturnType<typeof setTimeout> | null = null;
  /** Remote pointer in crop pixels (floats) and the crop it belongs to. */
  let pos: { x: number; y: number; key: string } | null = null;
  let lastLocal = Number.NEGATIVE_INFINITY;
  let lastZoom = MIN_ZOOM;

  const bar = document.createElement('div');
  bar.className = 'touch-buttons';
  bar.innerHTML =
    '<button type="button" data-touch="keyboard" aria-label="Bật/tắt bàn phím ảo" title="Bàn phím ảo">⌨</button>' +
    '<button type="button" data-touch="keys" aria-label="Phím đặc biệt" title="Phím đặc biệt">Phím</button>' +
    '<button type="button" data-touch="paste" aria-label="Dán sang Windows" title="Dán clipboard của thiết bị sang Windows">Dán</button>';
  el.append(bar);
  const keyboardButton = bar.querySelector<HTMLButtonElement>('[data-touch="keyboard"]')!;
  const keysButton = bar.querySelector<HTMLButtonElement>('[data-touch="keys"]')!;
  const pasteButton = bar.querySelector<HTMLButtonElement>('[data-touch="paste"]')!;

  // --- remote pointer ----------------------------------------------------------------------

  function wire(v: View, r: Region): Point | null {
    if (!pos || pos.key !== r.key) return null;
    return {
      x: clamp(Math.floor(pos.x), 0, r.w - 1) + v.crop.x + v.virtualLeft,
      y: clamp(Math.floor(pos.y), 0, r.h - 1) + v.crop.y + v.virtualTop,
    };
  }

  /** Make sure `pos` belongs to the current crop; adopt the host pointer when idle. */
  function seed(v: View, r: Region): void {
    const idle = now() - lastLocal >= ADOPT_HOST_AFTER_MS;
    if (pos && pos.key === r.key && !idle) return;
    const host = h.remotePosition?.() ?? null;
    if (host) {
      const x = host.x - v.virtualLeft - v.crop.x;
      const y = host.y - v.virtualTop - v.crop.y;
      if (x >= 0 && y >= 0 && x < r.w && y < r.h) {
        pos = { x, y, key: r.key };
        return;
      }
    }
    if (!pos || pos.key !== r.key) pos = { x: r.w / 2, y: r.h / 2, key: r.key };
  }

  /** The current wire point, seeded for the current crop. */
  function current(): Point | null {
    const v = getView();
    const r = regionOf(v);
    if (!r) return null;
    seed(v, r);
    return wire(v, r);
  }

  function moveBy(dxCss: number, dyCss: number, factor: number): void {
    const v = getView();
    const r = regionOf(v);
    if (!r) return;
    seed(v, r);
    if (!pos) return;
    const s = displayScale(v, r);
    pos.x = clamp(pos.x + (dxCss * factor) / s, 0, r.w - 1);
    pos.y = clamp(pos.y + (dyCss * factor) / s, 0, r.h - 1);
    lastLocal = now();
    const p = wire(v, r);
    if (p) h.move(p);
  }

  function click(button: PointerButton): void {
    const p = current();
    if (!p) return;
    lastLocal = now();
    h.down(button, p);
    h.up(button, p);
  }

  function pressLeft(down: boolean): void {
    const p = current();
    if (!p) return;
    lastLocal = now();
    if (down) h.down(0, p);
    else h.up(0, p);
  }

  function takePendingClick(): boolean {
    if (pendingClick === null) return false;
    clearTimeout(pendingClick);
    pendingClick = null;
    return true;
  }

  // --- gestures ----------------------------------------------------------------------------

  const centroid = (): Point => {
    let x = 0;
    let y = 0;
    for (const f of fingers.values()) {
      x += f.x;
      y += f.y;
    }
    return { x: x / fingers.size, y: y / fingers.size };
  };

  const spread = (): number => {
    const [a, b] = [...fingers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const control = () => h.enabled?.() !== false;
  const zoomNow = () => h.zoomScale?.() ?? lastZoom;

  function onDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || bar.contains(e.target as Node)) return;
    bar.classList.add('touch-seen');
    e.preventDefault();
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    if (fingers.size === 1) {
      const afterTap = takePendingClick();
      const enabled = control();
      gesture = {
        start: now(),
        mode: enabled ? 'pending' : 'idle',
        maxFingers: 1,
        afterTap: afterTap && enabled,
        control: enabled,
        d0: 0,
        c0: { x: e.clientX, y: e.clientY },
        prevC: { x: e.clientX, y: e.clientY },
        startScale: zoomNow(),
      };
      return;
    }
    const g = gesture;
    if (!g || g.mode === 'cancelled') return;
    g.maxFingers = Math.max(g.maxFingers, fingers.size);
    if (fingers.size !== 2) {
      // A third finger: no tap; the two-finger gesture in progress goes on with the first two.
      return;
    }
    // One finger became two: finish what the first finger was doing.
    if (g.mode === 'drag') pressLeft(false);
    if (g.afterTap) click(0); // the waiting tap stays a click
    g.afterTap = false;
    g.mode = 'pending2';
    g.d0 = spread();
    g.c0 = centroid();
    g.prevC = g.c0;
    g.startScale = zoomNow();
  }

  function onMove(e: PointerEvent): void {
    const f = fingers.get(e.pointerId);
    if (!f || e.pointerType !== 'touch') return;
    e.preventDefault();
    const dx = e.clientX - f.x;
    const dy = e.clientY - f.y;
    f.x = e.clientX;
    f.y = e.clientY;
    const g = gesture;
    if (!g) return;
    if (fingers.size === 1 && g.maxFingers === 1) oneFinger(g, f, dx, dy);
    else if (fingers.size >= 2) twoFingers(g);
  }

  function oneFinger(g: Gesture, f: Finger, dx: number, dy: number): void {
    if (g.mode === 'pending') {
      const tx = f.x - f.startX;
      const ty = f.y - f.startY;
      if (Math.hypot(tx, ty) < TAP_SLOP_PX) return;
      g.mode = g.afterTap ? 'drag' : 'move';
      g.afterTap = false;
      if (g.mode === 'drag') pressLeft(true);
      // The travel inside the tap slop is applied now, unaccelerated.
      moveBy(tx, ty, 1);
      return;
    }
    if (g.mode === 'move' || g.mode === 'drag') moveBy(dx, dy, acceleration(Math.hypot(dx, dy)));
  }

  function twoFingers(g: Gesture): void {
    const c = centroid();
    if (g.mode === 'pending2') {
      if (Math.abs(spread() - g.d0) >= PINCH_SLOP_PX && g.d0 > 0) g.mode = 'pinch';
      else if (Math.hypot(c.x - g.c0.x, c.y - g.c0.y) >= TAP_SLOP_PX) {
        if (zoomNow() > MIN_ZOOM) g.mode = 'pan';
        else if (g.control) {
          g.mode = 'scroll';
          // The wheel message carries the pointer position: put it where the pointer is.
          const p = current();
          if (p) h.move(p);
        } else g.mode = 'idle';
      } else return;
    }
    const dx = c.x - g.prevC.x;
    const dy = c.y - g.prevC.y;
    switch (g.mode) {
      case 'pinch': {
        const scale = clamp((g.startScale * spread()) / g.d0, MIN_ZOOM, MAX_ZOOM);
        lastZoom = scale;
        // About the previous midpoint, then follow the fingers.
        h.zoom(scale, g.prevC);
        if (dx !== 0 || dy !== 0) h.pan?.(dx, dy);
        break;
      }
      case 'pan':
        if (dx !== 0 || dy !== 0) h.pan?.(dx, dy);
        break;
      case 'scroll':
        if (dy !== 0) {
          lastLocal = now();
          h.wheel(-dy);
        }
        break;
      default:
        break;
    }
    g.prevC = c;
  }

  function onUp(e: PointerEvent): void {
    const f = fingers.get(e.pointerId);
    if (!f || e.pointerType !== 'touch') return;
    e.preventDefault();
    fingers.delete(e.pointerId);
    const g = gesture;
    if (!g) return;
    if (g.maxFingers === 1) {
      gesture = null;
      const quick = now() - g.start < TAP_MS;
      if (g.mode === 'drag') pressLeft(false);
      else if (g.mode === 'pending' && quick) {
        if (g.afterTap) {
          click(0);
          click(0);
        } else {
          pendingClick = setTimeout(() => {
            pendingClick = null;
            click(0);
          }, DOUBLE_TAP_MS);
        }
      } else if (g.mode === 'pending' && g.afterTap) click(0); // a long second touch: the first tap only
      return;
    }
    if (fingers.size > 0) return;
    gesture = null;
    if (g.maxFingers === 2 && g.mode === 'pending2' && g.control && now() - g.start < TWO_FINGER_TAP_MS) click(2);
  }

  function onCancel(e: PointerEvent): void {
    if (!fingers.has(e.pointerId) || e.pointerType !== 'touch') return;
    fingers.delete(e.pointerId);
    if (gesture) gesture.mode = 'cancelled';
    takePendingClick();
    if (fingers.size > 0) return;
    gesture = null;
    h.cancel?.();
  }

  // Floating buttons never take focus (the textarea keeps the soft keyboard) and are not gestures.
  const keepFocus = (e: Event) => e.preventDefault();
  const onKeyboard = () => h.showKeyboard();
  const onKeys = () => h.specialKeys?.();
  const onPaste = () => h.pasteLocal?.();
  const onBarDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') bar.classList.add('touch-seen');
    e.preventDefault();
  };

  const listeners: Array<[EventTarget, string, (e: never) => void, AddEventListenerOptions?]> = [
    [el, 'pointerdown', onDown, { passive: false }],
    [el, 'pointermove', onMove, { passive: false }],
    [el, 'pointerup', onUp, { passive: false }],
    [el, 'pointercancel', onCancel],
    [bar, 'pointerdown', onBarDown],
    [bar, 'mousedown', keepFocus],
    [keyboardButton, 'click', onKeyboard],
    [keysButton, 'click', onKeys],
    [pasteButton, 'click', onPaste],
  ];
  for (const [t, type, fn, opts] of listeners) t.addEventListener(type, fn as EventListener, opts);

  const reset = () => {
    takePendingClick();
    fingers.clear();
    gesture = null;
  };

  return {
    reset,
    detach() {
      for (const [t, type, fn, opts] of listeners) t.removeEventListener(type, fn as EventListener, opts);
      reset();
      bar.remove();
    },
  };
}

/**
 * Local zoom of the screen wrapper (screen canvas + cursor overlay) with a CSS transform
 * `translate(tx, ty) scale(s)` about the wrapper's top-left. Mouse/pen geometry stays right
 * because ScreenView.view() reads getBoundingClientRect, which includes the transform; the
 * overlay lives inside the wrapper, so it is given the untransformed size (layoutView).
 */
export class ViewZoom {
  private s = MIN_ZOOM;
  private tx = 0;
  private ty = 0;

  constructor(private readonly target: HTMLElement) {}

  get scale(): number {
    return this.s;
  }

  zoomTo(scale: number, center: Point): void {
    const next = clamp(Number.isFinite(scale) ? scale : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return;
    const r = this.target.getBoundingClientRect();
    const { w, h } = this.layoutSize(r);
    const ox = r.left - this.tx;
    const oy = r.top - this.ty;
    // The content point under `center` stays under it.
    const qx = (center.x - ox - this.tx) / this.s;
    const qy = (center.y - oy - this.ty) / this.s;
    this.tx = center.x - ox - next * qx;
    this.ty = center.y - oy - next * qy;
    this.s = next;
    this.clamp(w, h);
  }

  panBy(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const r = this.target.getBoundingClientRect();
    const { w, h } = this.layoutSize(r);
    this.tx += dx;
    this.ty += dy;
    this.clamp(w, h);
  }

  /** Re-clamp after a layout change (resize, rotation). */
  refit(): void {
    const { w, h } = this.layoutSize(this.target.getBoundingClientRect());
    this.clamp(w, h);
  }

  reset(): void {
    this.s = MIN_ZOOM;
    this.tx = 0;
    this.ty = 0;
    this.apply();
  }

  /** `v` with the canvas box as laid out inside the wrapper (no zoom), for the overlay. */
  layoutView(v: View): View {
    if (this.s === MIN_ZOOM && this.tx === 0 && this.ty === 0) return v;
    const r = this.target.getBoundingClientRect();
    const ox = r.left - this.tx;
    const oy = r.top - this.ty;
    const c = v.canvasRect;
    return {
      ...v,
      canvasRect: {
        left: ox + (c.left - ox - this.tx) / this.s,
        top: oy + (c.top - oy - this.ty) / this.s,
        width: c.width / this.s,
        height: c.height / this.s,
      },
    };
  }

  /** Untransformed wrapper size, from a rect measured with the current (applied) transform. */
  private layoutSize(r: DOMRect): { w: number; h: number } {
    return { w: r.width / this.s, h: r.height / this.s };
  }

  private clamp(w: number, h: number): void {
    this.tx = clamp(this.tx, w * (1 - this.s), 0);
    this.ty = clamp(this.ty, h * (1 - this.s), 0);
    this.apply();
  }

  private apply(): void {
    const identity = this.s === MIN_ZOOM && this.tx === 0 && this.ty === 0;
    this.target.style.transform = identity ? '' : `translate(${round(this.tx)}px, ${round(this.ty)}px) scale(${round(this.s)})`;
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000 + 0;
