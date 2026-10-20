// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { View } from '../input/geometry';
import { acceleration, attachTouch, ViewZoom, type TouchHandlers } from './touch';

type Call = [string, ...unknown[]];

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

describe('touch trackpad mode', () => {
  let el: HTMLDivElement;
  let screen: HTMLCanvasElement;
  let calls: Call[];
  let current: View;
  let zoomScale: number;
  let enabled: boolean;
  let host: { x: number; y: number } | null;
  let detach: () => void;

  const handlers = (): TouchHandlers => ({
    move: (p) => calls.push(['move', p.x, p.y]),
    down: (b, p) => calls.push(['down', b, p.x, p.y]),
    up: (b, p) => calls.push(['up', b, p.x, p.y]),
    wheel: (dy) => calls.push(['wheel', dy]),
    zoom: (s, c) => {
      zoomScale = s;
      calls.push(['zoom', s, c.x, c.y]);
    },
    pan: (dx, dy) => calls.push(['pan', dx, dy]),
    zoomScale: () => zoomScale,
    showKeyboard: () => calls.push(['keyboard']),
    specialKeys: () => calls.push(['specialKeys']),
    cancel: () => calls.push(['cancel']),
    enabled: () => enabled,
    remotePosition: () => host,
  });

  function touch(type: string, id: number, x: number, y: number, init: PointerEventInit = {}, target: Element = screen): PointerEvent {
    const e = new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType: 'touch', isPrimary: id === 1, ...init,
    });
    target.dispatchEvent(e);
    return e;
  }

  /** Moves pointer `id` from (x0,y0) by (dx,dy) in `steps` equal events. */
  function drag(id: number, x0: number, y0: number, dx: number, dy: number, steps: number): void {
    for (let i = 1; i <= steps; i++) touch('pointermove', id, x0 + (dx * i) / steps, y0 + (dy * i) / steps);
  }

  const named = (name: string) => calls.filter((c) => c[0] === name);
  const sent = () => calls.filter((c) => ['move', 'down', 'up', 'wheel'].includes(c[0]));

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="vp"><canvas id="s"></canvas></div>';
    el = document.querySelector('#vp')!;
    screen = document.querySelector('#s')!;
    calls = [];
    current = view();
    zoomScale = 1;
    enabled = true;
    host = null;
    detach = attachTouch(el, handlers(), () => current, { now: () => Date.now() });
  });

  afterEach(() => {
    detach();
    vi.useRealTimers();
  });

  test('a quick tap left-clicks at the current remote pointer (after the double-tap window)', () => {
    const down = touch('pointerdown', 1, 100, 100);
    expect(down.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(80);
    touch('pointerup', 1, 102, 101);
    expect(sent()).toEqual([]);
    vi.advanceTimersByTime(300);
    // No host position yet: the pointer starts at the centre of the 1920x1080 crop.
    expect(sent()).toEqual([
      ['down', 0, 960, 540],
      ['up', 0, 960, 540],
    ]);
  });

  test('a slow tap (>= 200 ms) or one that moved >= 10 px is not a click', () => {
    touch('pointerdown', 1, 100, 100);
    vi.advanceTimersByTime(250);
    touch('pointerup', 1, 100, 100);
    vi.advanceTimersByTime(500);
    expect(named('down')).toEqual([]);
    touch('pointerdown', 1, 100, 100);
    touch('pointermove', 1, 112, 100);
    touch('pointerup', 1, 112, 100);
    vi.advanceTimersByTime(500);
    expect(named('down')).toEqual([]);
  });

  test('a one-finger drag of 100 px moves the remote pointer relatively (scale 0.5 => 200 remote px)', () => {
    touch('pointerdown', 1, 300, 300);
    drag(1, 300, 300, 100, 0, 50); // 2 px per event: no acceleration
    touch('pointerup', 1, 400, 300);
    vi.advanceTimersByTime(500);
    expect(named('down')).toEqual([]);
    expect(named('move').at(-1)).toEqual(['move', 1160, 540]);
    // Relative: where the finger is does not matter, only how far it went.
    touch('pointerdown', 1, 900, 50);
    drag(1, 900, 50, 0, 40, 20);
    touch('pointerup', 1, 900, 90);
    expect(named('move').at(-1)).toEqual(['move', 1160, 620]);
  });

  test('fast moves are accelerated (x2.5 at >= 20 px per event) and the pointer stays inside the crop', () => {
    expect(acceleration(2)).toBe(1);
    expect(acceleration(4)).toBe(1);
    expect(acceleration(12)).toBeCloseTo(1.75);
    expect(acceleration(20)).toBe(2.5);
    expect(acceleration(80)).toBe(2.5);
    touch('pointerdown', 1, 100, 100);
    touch('pointermove', 1, 110, 100); // crosses the slop: the first 10 px at factor 1 => +20
    touch('pointermove', 1, 130, 100); // 20 px at x2.5 => +100
    expect(named('move').at(-1)).toEqual(['move', 1080, 540]);
    drag(1, 130, 100, 900, 0, 9); // 100 px per event: far past the right edge
    expect(named('move').at(-1)).toEqual(['move', 1919, 540]);
    touch('pointerup', 1, 1030, 100);
  });

  test('wire coordinates add the monitor crop and the virtual origin', () => {
    current = view({ imageW: 3840, crop: { x: 1920, y: 0, w: 1920, h: 1080 }, virtualLeft: -1920 });
    touch('pointerdown', 1, 100, 100);
    touch('pointerup', 1, 100, 100);
    vi.advanceTimersByTime(300);
    // Centre of monitor 2 (crop x 1920) in a virtual desktop starting at -1920.
    expect(named('down')).toEqual([['down', 0, 960, 540]]);
  });

  test('the host-reported pointer is adopted when the trackpad was idle', () => {
    host = { x: 100, y: 200 };
    touch('pointerdown', 1, 10, 10);
    touch('pointerup', 1, 10, 10);
    vi.advanceTimersByTime(300);
    expect(named('down')).toEqual([['down', 0, 100, 200]]);
    // Right after local activity, a stale host position does not pull the pointer back.
    touch('pointerdown', 1, 10, 10);
    drag(1, 10, 10, 20, 0, 10);
    touch('pointerup', 1, 30, 10);
    host = { x: 100, y: 200 };
    touch('pointerdown', 1, 10, 10);
    touch('pointerup', 1, 10, 10);
    vi.advanceTimersByTime(300);
    expect(named('down').at(-1)).toEqual(['down', 0, 140, 200]);
    vi.advanceTimersByTime(1500);
    host = { x: 7, y: 8 };
    touch('pointerdown', 1, 10, 10);
    touch('pointerup', 1, 10, 10);
    vi.advanceTimersByTime(300);
    expect(named('down').at(-1)).toEqual(['down', 0, 7, 8]);
  });

  test('tap then touch-and-drag holds the left button: down, moves, up (no click before it)', () => {
    touch('pointerdown', 1, 200, 200);
    touch('pointerup', 1, 200, 200);
    vi.advanceTimersByTime(100);
    touch('pointerdown', 1, 205, 200);
    drag(1, 205, 200, 50, 0, 25);
    touch('pointerup', 1, 255, 200);
    vi.advanceTimersByTime(500);
    const s = sent();
    expect(s[0]).toEqual(['down', 0, 960, 540]);
    expect(s.slice(1, -1).every((c) => c[0] === 'move')).toBe(true);
    expect(s.length).toBeGreaterThan(3);
    expect(s.at(-1)).toEqual(['up', 0, 1060, 540]);
    expect(named('down')).toHaveLength(1);
  });

  test('a double tap sends two clicks right away', () => {
    touch('pointerdown', 1, 200, 200);
    touch('pointerup', 1, 200, 200);
    vi.advanceTimersByTime(100);
    touch('pointerdown', 1, 200, 200);
    touch('pointerup', 1, 200, 200);
    expect(sent()).toEqual([
      ['down', 0, 960, 540],
      ['up', 0, 960, 540],
      ['down', 0, 960, 540],
      ['up', 0, 960, 540],
    ]);
    vi.advanceTimersByTime(500);
    expect(sent()).toHaveLength(4);
  });

  test('a two-finger quick tap right-clicks at the remote pointer', () => {
    touch('pointerdown', 1, 100, 100);
    touch('pointerdown', 2, 200, 100);
    vi.advanceTimersByTime(60);
    touch('pointerup', 1, 101, 100);
    touch('pointerup', 2, 200, 101);
    vi.advanceTimersByTime(500);
    expect(sent()).toEqual([
      ['down', 2, 960, 540],
      ['up', 2, 960, 540],
    ]);
  });

  test('a two-finger drag down of 120 px scrolls (negative wheel deltaY, natural direction)', () => {
    touch('pointerdown', 1, 100, 100);
    touch('pointerdown', 2, 200, 100);
    for (let i = 1; i <= 12; i++) {
      touch('pointermove', 1, 100, 100 + i * 10);
      touch('pointermove', 2, 200, 100 + i * 10);
    }
    touch('pointerup', 1, 100, 220);
    touch('pointerup', 2, 200, 220);
    vi.advanceTimersByTime(500);
    const total = named('wheel').reduce((sum, c) => sum + (c[1] as number), 0);
    expect(total).toBe(-120);
    expect(named('down')).toEqual([]);
    expect(named('zoom')).toEqual([]);
    // The wheel is placed at the remote pointer first.
    expect(sent()[0]).toEqual(['move', 960, 540]);
  });

  test('pinching 2x zooms the local view to 2 and sends nothing', () => {
    touch('pointerdown', 1, 380, 270);
    touch('pointerdown', 2, 580, 270);
    for (let i = 1; i <= 10; i++) {
      touch('pointermove', 1, 380 - i * 10, 270);
      touch('pointermove', 2, 580 + i * 10, 270);
    }
    touch('pointerup', 1, 280, 270);
    touch('pointerup', 2, 680, 270);
    vi.advanceTimersByTime(500);
    const last = named('zoom').at(-1)!;
    expect(last[1]).toBe(2);
    // About the fingers' midpoint (the previous one; the pan that follows moves it to the current one).
    expect(Math.abs((last[2] as number) - 480)).toBeLessThanOrEqual(5);
    expect(last[3]).toBe(270);
    expect(sent()).toEqual([]);
  });

  test('zoom is kept between 1x and 4x', () => {
    touch('pointerdown', 1, 470, 270);
    touch('pointerdown', 2, 490, 270);
    touch('pointermove', 1, 100, 270);
    touch('pointermove', 2, 860, 270);
    expect(named('zoom').at(-1)?.[1]).toBe(4);
    touch('pointermove', 1, 479, 270);
    touch('pointermove', 2, 481, 270);
    expect(named('zoom').at(-1)?.[1]).toBe(1);
  });

  test('a two-finger drag while zoomed pans the local view instead of scrolling', () => {
    zoomScale = 2;
    touch('pointerdown', 1, 100, 100);
    touch('pointerdown', 2, 200, 100);
    for (let i = 1; i <= 5; i++) {
      touch('pointermove', 1, 100 + i * 6, 100 + i * 4);
      touch('pointermove', 2, 200 + i * 6, 100 + i * 4);
    }
    touch('pointerup', 1, 130, 120);
    touch('pointerup', 2, 230, 120);
    const dx = named('pan').reduce((s, c) => s + (c[1] as number), 0);
    const dy = named('pan').reduce((s, c) => s + (c[2] as number), 0);
    expect([dx, dy]).toEqual([30, 20]);
    expect(named('wheel')).toEqual([]);
    expect(sent()).toEqual([]);
  });

  test('pointercancel ends the gesture and asks for releaseAll; a cancelled tap does not click', () => {
    touch('pointerdown', 1, 200, 200);
    touch('pointerup', 1, 200, 200);
    touch('pointerdown', 1, 200, 200);
    drag(1, 200, 200, 30, 0, 10); // tap-tap-drag: left button held
    expect(named('down')).toHaveLength(1);
    touch('pointercancel', 1, 230, 200);
    expect(calls.at(-1)).toEqual(['cancel']);
    vi.advanceTimersByTime(500);
    expect(named('up')).toEqual([]); // the page's releaseAll lifts the button
    touch('pointerdown', 1, 10, 10);
    touch('pointercancel', 1, 10, 10);
    vi.advanceTimersByTime(500);
    expect(named('down')).toHaveLength(1);
  });

  test('mouse and pen pointers are left to the desktop path', () => {
    for (const pointerType of ['mouse', 'pen']) {
      const e = touch('pointerdown', 9, 100, 100, { pointerType });
      touch('pointerup', 9, 100, 100, { pointerType });
      expect(e.defaultPrevented).toBe(false);
    }
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([]);
  });

  test('without control nothing is sent, but pinch-zoom still works', () => {
    enabled = false;
    touch('pointerdown', 1, 100, 100);
    touch('pointerup', 1, 100, 100);
    vi.advanceTimersByTime(300);
    touch('pointerdown', 1, 100, 100);
    drag(1, 100, 100, 50, 0, 10);
    touch('pointerup', 1, 150, 100);
    touch('pointerdown', 1, 380, 270);
    touch('pointerdown', 2, 580, 270);
    touch('pointermove', 1, 280, 270);
    touch('pointermove', 2, 680, 270);
    expect(sent()).toEqual([]);
    expect(named('zoom').at(-1)?.[1]).toBe(2);
  });

  test('floating ⌨ and Phím buttons call their handlers and are not gestures', () => {
    const keyboard = el.querySelector<HTMLButtonElement>('[data-touch="keyboard"]')!;
    const keys = el.querySelector<HTMLButtonElement>('[data-touch="keys"]')!;
    expect(keyboard.textContent).toBe('⌨');
    expect(keys.textContent).toBe('Phím');
    const down = touch('pointerdown', 1, 900, 500, {}, keyboard);
    expect(down.defaultPrevented).toBe(true); // keeps focus where it is
    touch('pointerup', 1, 900, 500, {}, keyboard);
    keyboard.click();
    keys.click();
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([['keyboard'], ['specialKeys']]);
    // The first touch reveals the buttons on devices that do not match (pointer: coarse).
    expect(el.querySelector('.touch-buttons')!.classList.contains('touch-seen')).toBe(true);
    detach();
    expect(el.querySelector('.touch-buttons')).toBeNull();
    detach = () => {};
  });
});

describe('ViewZoom (local pinch-zoom of the screen wrapper)', () => {
  function setup() {
    const wrapper = document.createElement('div');
    const zoom = new ViewZoom(wrapper);
    // Layout box 960x540 at (10, 20); the bounding rect follows the CSS transform.
    wrapper.getBoundingClientRect = () => {
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(wrapper.style.transform);
      const [tx, ty, s] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1];
      return DOMRect.fromRect({ x: 10 + tx, y: 20 + ty, width: 960 * s, height: 540 * s });
    };
    return { wrapper, zoom };
  }

  test('zooming about a point keeps that point fixed and pans are clamped to the content', () => {
    const { wrapper, zoom } = setup();
    expect(wrapper.style.transform).toBe('');
    zoom.zoomTo(2, { x: 490, y: 290 }); // the layout centre
    expect(zoom.scale).toBe(2);
    expect(wrapper.style.transform).toBe('translate(-480px, -270px) scale(2)');
    zoom.panBy(100, 0);
    expect(wrapper.style.transform).toBe('translate(-380px, -270px) scale(2)');
    zoom.panBy(1000, 1000); // cannot reveal past the top-left edge
    expect(wrapper.style.transform).toBe('translate(0px, 0px) scale(2)');
    zoom.panBy(-5000, -5000);
    expect(wrapper.style.transform).toBe('translate(-960px, -540px) scale(2)');
    zoom.zoomTo(9, { x: 10, y: 20 });
    expect(zoom.scale).toBe(4);
    zoom.zoomTo(0.5, { x: 10, y: 20 });
    expect(zoom.scale).toBe(1);
    expect(wrapper.style.transform).toBe('');
  });

  test('layoutView undoes the zoom for the cursor overlay inside the wrapper', () => {
    const { zoom } = setup();
    zoom.zoomTo(2, { x: 490, y: 290 });
    const v = zoom.layoutView(view({ canvasRect: { left: -470, top: -250, width: 1920, height: 1080 } }));
    expect(v.canvasRect).toEqual({ left: 10, top: 20, width: 960, height: 540 });
    zoom.reset();
    expect(zoom.scale).toBe(1);
  });
});
