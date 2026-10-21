// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AnnotationModel, INK_COLORS, openAnnotator, paintMarks, renderExport, type AnnotatorHandle } from './annotate';
import { MAX_MARKS, MAX_POINTS_PER_STROKE } from './capture';

/** Records the drawing calls of a canvas (jsdom has no 2D context). */
interface Call {
  op: string;
  args: unknown[];
  style?: string;
  width?: number;
}
function fakeContext(calls: Call[]): CanvasRenderingContext2D {
  const state = { strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: '', lineJoin: '' };
  return new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      return (...args: unknown[]) => {
        calls.push({ op: prop, args, style: target.strokeStyle || target.fillStyle, width: target.lineWidth });
      };
    },
    set(target, prop: string, value) {
      (target as Record<string, unknown>)[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

describe('AnnotationModel', () => {
  test('annotate mode starts on the pen with the full image selected', () => {
    const m = new AnnotationModel(128, 64, false);
    expect(m.tool).toBe('pen');
    expect(m.selection).toEqual({ x: 0, y: 0, w: 128, h: 64 });
    expect(m.canExport).toBe(true);
  });

  test('region mode starts with nothing selected; a reverse drag is normalized; < 2×2 cannot export', () => {
    const m = new AnnotationModel(128, 64, true);
    expect(m.tool).toBe('region');
    expect(m.canExport).toBe(false);
    m.begin({ x: 128, y: 32 });
    expect(m.canExport).toBe(false);
    m.drag({ x: 0, y: 0 });
    m.end();
    expect(m.selection).toEqual({ x: 0, y: 0, w: 128, h: 32 });
    expect(m.exportRegion()).toEqual({ x: 0, y: 0, w: 128, h: 32 });
    m.begin({ x: 10, y: 10 });
    m.drag({ x: 11, y: 30 });
    m.end();
    expect(m.canExport).toBe(false);
    expect(m.exportRegion()).toBeNull();
  });

  test('points outside the image are clamped', () => {
    const m = new AnnotationModel(100, 50, true);
    m.begin({ x: -20, y: 70 });
    m.drag({ x: 500, y: -9 });
    expect(m.selection).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  test('Toàn ảnh selects everything again', () => {
    const m = new AnnotationModel(100, 50, true);
    m.begin({ x: 5, y: 5 });
    m.drag({ x: 40, y: 20 });
    m.end();
    m.useFullImage();
    expect(m.selection).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  test('pen collects points, rectangle keeps [start, end], undo removes the last mark', () => {
    const m = new AnnotationModel(200, 100, false);
    m.ink = 'yellow';
    m.begin({ x: 1, y: 1 });
    m.drag({ x: 2, y: 2 });
    m.drag({ x: 3, y: 3 });
    m.end();
    m.tool = 'rect';
    m.ink = 'blue';
    m.begin({ x: 10, y: 10 });
    m.drag({ x: 20, y: 30 });
    m.drag({ x: 50, y: 60 });
    m.end();
    expect(m.marks).toEqual([
      { tool: 'pen', ink: 'yellow', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] },
      { tool: 'rect', ink: 'blue', points: [{ x: 10, y: 10 }, { x: 50, y: 60 }] },
    ]);
    m.undo();
    expect(m.marks).toHaveLength(1);
    m.undo();
    m.undo();
    expect(m.marks).toHaveLength(0);
  });

  test('drag without begin does nothing', () => {
    const m = new AnnotationModel(200, 100, false);
    m.drag({ x: 5, y: 5 });
    expect(m.marks).toHaveLength(0);
  });

  test(`at most ${MAX_MARKS} marks: the oldest goes first`, () => {
    const m = new AnnotationModel(200, 100, false);
    for (let i = 0; i < MAX_MARKS + 5; i++) {
      m.begin({ x: i % 200, y: 0 });
      m.end();
    }
    expect(m.marks).toHaveLength(MAX_MARKS);
    expect(m.marks[0]!.points[0]).toEqual({ x: 5, y: 0 });
    expect(m.marks[MAX_MARKS - 1]!.points[0]).toEqual({ x: (MAX_MARKS + 4) % 200, y: 0 });
  });

  test(`at most ${MAX_POINTS_PER_STROKE} points per stroke`, () => {
    const m = new AnnotationModel(200, 100, false);
    m.begin({ x: 0, y: 0 });
    for (let i = 0; i < MAX_POINTS_PER_STROKE + 10; i++) m.drag({ x: i % 200, y: 5 });
    expect(m.marks[0]!.points).toHaveLength(MAX_POINTS_PER_STROKE);
  });

  test('stroke width is max(2, min(w,h)/350)', () => {
    expect(new AnnotationModel(128, 64, false).strokeWidth).toBe(2);
    expect(new AnnotationModel(1920, 1080, false).strokeWidth).toBeCloseTo(1080 / 350, 10);
  });
});

describe('renderExport / paintMarks', () => {
  let calls: Call[];
  beforeEach(() => {
    calls = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => fakeContext(calls)) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  function image(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  test('crops the region at source resolution and draws marks translated by its origin', () => {
    const m = new AnnotationModel(1920, 1080, true);
    m.begin({ x: 500, y: 300 });
    m.drag({ x: 900, y: 700 });
    m.end();
    m.tool = 'pen';
    m.ink = 'yellow';
    m.begin({ x: 520, y: 320 });
    m.drag({ x: 620, y: 320 });
    m.end();
    m.tool = 'rect';
    m.ink = 'blue';
    m.begin({ x: 800, y: 600 });
    m.drag({ x: 700, y: 400 }); // reverse drag
    m.end();

    const src = image(1920, 1080);
    const out = renderExport(m, src)!;
    expect([out.width, out.height]).toEqual([400, 400]);
    const draw = calls.find((c) => c.op === 'drawImage')!;
    expect(draw.args).toEqual([src, 500, 300, 400, 400, 0, 0, 400, 400]);
    const line = calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo');
    expect(line.map((c) => c.args)).toEqual([[20, 20], [120, 20]]);
    const stroke = calls.find((c) => c.op === 'stroke')!;
    expect(stroke.style).toBe(INK_COLORS.yellow);
    expect(stroke.width).toBeCloseTo(1080 / 350, 10);
    const rect = calls.find((c) => c.op === 'strokeRect')!;
    expect(rect.args).toEqual([200, 100, 100, 200]);
    expect(rect.style).toBe(INK_COLORS.blue);
  });

  test('nothing to export without a >= 2×2 selection', () => {
    const m = new AnnotationModel(100, 100, true);
    expect(renderExport(m, image(100, 100))).toBeNull();
    m.begin({ x: 1, y: 1 });
    m.drag({ x: 2, y: 2 });
    expect(renderExport(m, image(100, 100))).toBeNull();
  });

  test('a single-point pen mark is a dot of the stroke width', () => {
    const ctx = fakeContext(calls);
    paintMarks(ctx, [{ tool: 'pen', ink: 'red', points: [{ x: 10, y: 20 }] }], { originX: 4, originY: 4, scale: 2, lineWidth: 3 });
    expect(calls.find((c) => c.op === 'arc')!.args).toEqual([12, 32, 1.5, 0, Math.PI * 2]);
    expect(calls.some((c) => c.op === 'fill')).toBe(true);
  });
});

describe('openAnnotator modal', () => {
  let calls: Call[];
  let saved: Blob[];
  let closed: number;
  let handle: AnnotatorHandle;
  const $ = <T extends HTMLElement>(sel: string) => document.body.querySelector<T>(sel)!;

  function setup(selectRegion: boolean, w = 200, h = 100): void {
    const img = document.createElement('canvas');
    img.width = w;
    img.height = h;
    handle = openAnnotator({ image: img, selectRegion, save: (b) => saved.push(b), closed: () => closed++ });
    // The preview shows the 200×100 image in a 100×50 box: 2 source pixels per client pixel.
    $<HTMLCanvasElement>('.cap-canvas').getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 50, right: 110, bottom: 70, x: 10, y: 20, toJSON: () => ({}) });
  }

  function pointer(type: string, x: number, y: number, id = 1): void {
    const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: 'touch' } });
    $<HTMLCanvasElement>('.cap-canvas').dispatchEvent(e);
  }

  beforeEach(() => {
    calls = [];
    saved = [];
    closed = 0;
    document.body.innerHTML = '';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => fakeContext(calls)) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      cb(new Blob(['png'], { type: 'image/png' }));
    });
  });
  afterEach(() => {
    handle?.close();
    vi.restoreAllMocks();
  });

  test('is a full-page dialog with every control in Vietnamese', () => {
    setup(false);
    const dialog = $('.cap-modal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labels = [...dialog.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'));
    expect(labels).toEqual(['Chọn vùng', 'Bút', 'Chữ nhật', 'Màu đỏ', 'Màu vàng', 'Màu xanh', 'Hoàn tác', 'Toàn ảnh', 'Lưu PNG', 'Đóng']);
    expect($<HTMLButtonElement>('[data-tool="pen"]').getAttribute('aria-pressed')).toBe('true');
    expect($<HTMLButtonElement>('[data-ink="red"]').getAttribute('aria-pressed')).toBe('true');
  });

  test('region mode: Lưu PNG stays disabled until a region of at least 2×2 is dragged', () => {
    setup(true);
    expect($<HTMLButtonElement>('[data-tool="region"]').getAttribute('aria-pressed')).toBe('true');
    expect($<HTMLButtonElement>('.cap-save').disabled).toBe(true);
    pointer('pointerdown', 60, 45); // source (100, 50)
    pointer('pointermove', 30, 30); // source (40, 20)
    pointer('pointerup', 30, 30);
    expect($('.cap-size').textContent).toBe('60 × 30');
    expect($<HTMLButtonElement>('.cap-save').disabled).toBe(false);
    pointer('pointerdown', 50, 50);
    pointer('pointerup', 50.5, 50.5);
    expect($<HTMLButtonElement>('.cap-save').disabled).toBe(true);
  });

  test('draws with the pen in the chosen colour, Hoàn tác undoes, Lưu PNG saves the cropped, annotated PNG', async () => {
    setup(false);
    $<HTMLButtonElement>('[data-ink="blue"]').click();
    pointer('pointerdown', 20, 30);
    pointer('pointermove', 40, 30);
    pointer('pointerup', 40, 30);
    expect($<HTMLButtonElement>('.cap-undo').disabled).toBe(false);
    $<HTMLButtonElement>('.cap-undo').click();
    expect($<HTMLButtonElement>('.cap-undo').disabled).toBe(true);

    $<HTMLButtonElement>('[data-tool="rect"]').click();
    $<HTMLButtonElement>('[data-ink="yellow"]').click();
    pointer('pointerdown', 20, 30);
    pointer('pointermove', 60, 50);
    pointer('pointerup', 60, 50);
    calls.length = 0;
    $<HTMLButtonElement>('.cap-save').click();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.type).toBe('image/png');
    expect(calls.find((c) => c.op === 'strokeRect')!.args).toEqual([20, 20, 80, 40]);
    expect(calls.find((c) => c.op === 'strokeRect')!.style).toBe(INK_COLORS.yellow);
  });

  test('Toàn ảnh restores the full selection', () => {
    setup(true);
    pointer('pointerdown', 20, 30);
    pointer('pointerup', 60, 50);
    $<HTMLButtonElement>('.cap-full').click();
    expect($('.cap-size').textContent).toBe('200 × 100');
  });

  test('a PNG encoding failure is shown and nothing is saved', async () => {
    setup(false);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      cb(null);
    });
    $<HTMLButtonElement>('.cap-save').click();
    await vi.waitFor(() => expect($<HTMLElement>('.cap-error').hidden).toBe(false));
    expect(saved).toHaveLength(0);
    expect($<HTMLButtonElement>('.cap-save').disabled).toBe(false);
  });

  test('Đóng and Esc close the modal once', () => {
    setup(false);
    $<HTMLButtonElement>('.cap-close').click();
    expect(document.querySelector('.cap-modal')).toBeNull();
    expect(closed).toBe(1);
    expect(handle.isOpen).toBe(false);
    setup(false);
    $('.cap-modal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.cap-modal')).toBeNull();
    expect(closed).toBe(2);
    handle.close();
    expect(closed).toBe(2);
  });

  test('a second finger is ignored while one is drawing', () => {
    setup(false);
    pointer('pointerdown', 20, 30, 1);
    pointer('pointerdown', 80, 40, 2);
    pointer('pointermove', 30, 30, 2);
    pointer('pointerup', 30, 30, 1);
    $<HTMLButtonElement>('.cap-undo').click();
    expect($<HTMLButtonElement>('.cap-undo').disabled).toBe(true);
  });
});
