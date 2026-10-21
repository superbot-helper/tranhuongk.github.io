// Screenshot annotator (port of MacViewer's RemoteCaptureEditor): a full-page modal over a
// snapshot of the decoded remote frame. Tools: select a region (drag, normalized, >= 2×2),
// freehand pen, rectangle; red / yellow / blue; undo; "Toàn ảnh"; "Lưu PNG" crops the region and
// draws the marks translated by its origin, at source resolution. Pointer events with
// touch-action none, so it works with a finger on a phone. The model is DOM-free.
import {
  canvasToPng,
  exportBounds,
  isExportableRegion,
  MAX_MARKS,
  MAX_POINTS_PER_STROKE,
  normalizeRegion,
  strokeWidth,
  type Point,
  type Region,
} from './capture';

export type Tool = 'region' | 'pen' | 'rect';
export type Ink = 'red' | 'yellow' | 'blue';

export const INKS: readonly Ink[] = ['red', 'yellow', 'blue'];
/** Same hues as the Swift editor (systemRed / systemYellow / systemBlue). */
export const INK_COLORS: Record<Ink, string> = { red: '#ff3b30', yellow: '#ffcc00', blue: '#0a84ff' };
const INK_LABELS: Record<Ink, string> = { red: 'Đỏ', yellow: 'Vàng', blue: 'Xanh' };

export interface Mark {
  tool: 'pen' | 'rect';
  ink: Ink;
  /** Pen: every point. Rectangle: [start, end]. */
  points: Point[];
}

export class AnnotationModel {
  tool: Tool;
  ink: Ink = 'red';
  selection: Region | null;
  marks: Mark[] = [];
  private origin: Point | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    selectRegion: boolean,
  ) {
    this.tool = selectRegion ? 'region' : 'pen';
    this.selection = selectRegion ? null : { x: 0, y: 0, w: width, h: height };
  }

  get canExport(): boolean {
    return isExportableRegion(this.selection);
  }

  get strokeWidth(): number {
    return strokeWidth(this.width, this.height);
  }

  private clamp(p: Point): Point {
    return { x: Math.min(this.width, Math.max(0, p.x)), y: Math.min(this.height, Math.max(0, p.y)) };
  }

  begin(at: Point): void {
    const p = this.clamp(at);
    this.origin = p;
    if (this.tool === 'region') {
      this.selection = { x: p.x, y: p.y, w: 0, h: 0 };
      return;
    }
    // The 201st mark pushes the oldest out.
    if (this.marks.length >= MAX_MARKS) this.marks.shift();
    this.marks.push({ tool: this.tool, ink: this.ink, points: [p] });
  }

  drag(to: Point): void {
    const origin = this.origin;
    if (!origin) return;
    const p = this.clamp(to);
    if (this.tool === 'region') {
      this.selection = normalizeRegion(origin, p);
      return;
    }
    const mark = this.marks[this.marks.length - 1];
    if (!mark) return;
    if (mark.tool === 'rect') mark.points = [origin, p];
    else if (mark.points.length < MAX_POINTS_PER_STROKE) mark.points.push(p);
  }

  end(): void {
    this.origin = null;
  }

  useFullImage(): void {
    this.selection = { x: 0, y: 0, w: this.width, h: this.height };
  }

  undo(): void {
    this.marks.pop();
  }

  /** The pixels "Lưu PNG" would save, or null while the selection is missing or under 2×2. */
  exportRegion(): Region | null {
    if (!this.canExport || !this.selection) return null;
    return exportBounds(this.selection, this.width, this.height);
  }
}

interface MarkPaint {
  /** Source point (originX, originY) is drawn at the canvas origin, then everything is multiplied by scale. */
  originX: number;
  originY: number;
  scale: number;
  lineWidth: number;
}

/** Draws the marks (pen strokes, rectangles, single-point dots) with the given source -> canvas mapping. */
export function paintMarks(ctx: CanvasRenderingContext2D, marks: readonly Mark[], m: MarkPaint): void {
  const map = (p: Point): Point => ({ x: (p.x - m.originX) * m.scale, y: (p.y - m.originY) * m.scale });
  ctx.save();
  ctx.lineWidth = m.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const mark of marks) {
    const first = mark.points[0];
    if (!first) continue;
    const a = map(first);
    const color = INK_COLORS[mark.ink];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (mark.tool === 'rect') {
      const b = map(mark.points[mark.points.length - 1] ?? first);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (mark.points.length === 1) {
      ctx.beginPath();
      ctx.arc(a.x, a.y, m.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      for (let i = 1; i < mark.points.length; i++) {
        const p = map(mark.points[i]!);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** The image to save: the selected region of `image` with the marks drawn on it at source resolution. Null if nothing is exportable. */
export function renderExport(
  model: AnnotationModel,
  image: HTMLCanvasElement,
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
): HTMLCanvasElement | null {
  const region = model.exportRegion();
  if (!region) return null;
  const out = createCanvas();
  out.width = region.w;
  out.height = region.h;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
  paintMarks(ctx, model.marks, { originX: region.x, originY: region.y, scale: 1, lineWidth: model.strokeWidth });
  return out;
}

export interface AnnotatorOptions {
  /** A snapshot of the frame (not the live screen canvas). */
  image: HTMLCanvasElement;
  /** "Chụp một vùng…": start on the region tool with nothing selected. */
  selectRegion: boolean;
  /** The PNG to save; the page starts the download. */
  save(blob: Blob): void;
  /** The modal closed (by Đóng, Esc, or `close()`). */
  closed(): void;
  /** The PNG could not be produced. */
  failed?(): void;
}

export interface AnnotatorHandle {
  readonly isOpen: boolean;
  close(): void;
}

const TOOLS: ReadonlyArray<[Tool, string]> = [
  ['region', 'Chọn vùng'],
  ['pen', 'Bút'],
  ['rect', 'Chữ nhật'],
];
const FALLBACK_STAGE = { width: 640, height: 400 };
const STAGE_PADDING = 24;
const HINT = 'Kéo trên ảnh để chọn vùng cần lưu.';

export function openAnnotator(o: AnnotatorOptions): AnnotatorHandle {
  const model = new AnnotationModel(o.image.width, o.image.height, o.selectRegion);
  const root = document.createElement('div');
  root.className = 'cap-modal';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Chụp và chú thích');
  root.innerHTML = `
    <div class="cap-bar">
      <div class="cap-group" role="group" aria-label="Công cụ">${TOOLS.map(
        ([t, label]) => `<button type="button" class="cap-tool" data-tool="${t}" aria-pressed="false">${label}</button>`,
      ).join('')}</div>
      <div class="cap-group" role="group" aria-label="Màu">${INKS.map(
        (c) =>
          `<button type="button" class="cap-ink" data-ink="${c}" aria-pressed="false" aria-label="Màu ${INK_LABELS[c].toLowerCase()}" title="${INK_LABELS[c]}" style="--ink:${INK_COLORS[c]}"></button>`,
      ).join('')}</div>
      <button type="button" class="cap-undo">Hoàn tác</button>
    </div>
    <div class="cap-stage"><canvas class="cap-canvas"></canvas></div>
    <div class="cap-bar cap-foot">
      <button type="button" class="cap-full">Toàn ảnh</button>
      <span class="cap-size" role="status"></span>
      <span class="cap-spacer"></span>
      <button type="button" class="cap-save">Lưu PNG</button>
      <button type="button" class="cap-close">Đóng</button>
    </div>
    <p class="cap-error" role="alert" hidden>Không tạo được ảnh PNG.</p>`;

  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const stage = q<HTMLDivElement>('.cap-stage');
  const canvas = q<HTMLCanvasElement>('.cap-canvas');
  const toolButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-tool]')];
  const inkButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-ink]')];
  const undo = q<HTMLButtonElement>('.cap-undo');
  const save = q<HTMLButtonElement>('.cap-save');
  const sizeEl = q<HTMLSpanElement>('.cap-size');
  const errorEl = q<HTMLParagraphElement>('.cap-error');
  let open = true;
  let saving = false;

  /** Preview pixels per source pixel. */
  const previewScale = (): number => (canvas.width > 0 && model.width > 0 ? canvas.width / model.width : 1);

  function render(): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const scale = previewScale();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(o.image, 0, 0, canvas.width, canvas.height);
    paintMarks(ctx, model.marks, { originX: 0, originY: 0, scale, lineWidth: Math.max(1, model.strokeWidth * scale) });
    const s = model.selection;
    if (s) {
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.36)';
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect(s.x * scale, s.y * scale, s.w * scale, s.h * scale);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(s.x * scale, s.y * scale, s.w * scale, s.h * scale);
      ctx.restore();
    }
  }

  function refresh(): void {
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === model.tool));
    for (const b of inkButtons) b.setAttribute('aria-pressed', String(b.dataset.ink === model.ink));
    undo.disabled = model.marks.length === 0;
    const region = model.exportRegion();
    save.disabled = region === null || saving;
    sizeEl.textContent = region ? `${region.w} × ${region.h}` : HINT;
    render();
  }

  /** Fits the preview inside the stage (contain), keeping the image aspect. */
  function fit(): void {
    const availW = (stage.clientWidth || FALLBACK_STAGE.width) - STAGE_PADDING;
    const availH = (stage.clientHeight || FALLBACK_STAGE.height) - STAGE_PADDING;
    const scale = Math.min(1, Math.max(0.01, availW) / model.width, Math.max(0.01, availH) / model.height);
    const w = Math.max(1, Math.round(model.width * scale));
    const h = Math.max(1, Math.round(model.height * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    render();
  }

  function sourcePoint(e: PointerEvent): Point {
    const r = canvas.getBoundingClientRect();
    const w = r.width || canvas.width;
    const h = r.height || canvas.height;
    return { x: ((e.clientX - r.left) / w) * model.width, y: ((e.clientY - r.top) / h) * model.height };
  }

  let pointerId: number | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    pointerId = e.pointerId;
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // The pointer is already gone; the drag simply ends.
    }
    model.begin(sourcePoint(e));
    refresh();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    e.preventDefault();
    model.drag(sourcePoint(e));
    render();
  });
  const finish = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (e.type === 'pointerup') model.drag(sourcePoint(e));
    model.end();
    refresh();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  for (const b of toolButtons) {
    b.addEventListener('click', () => {
      model.tool = b.dataset.tool as Tool;
      refresh();
    });
  }
  for (const b of inkButtons) {
    b.addEventListener('click', () => {
      model.ink = b.dataset.ink as Ink;
      refresh();
    });
  }
  undo.addEventListener('click', () => {
    model.undo();
    refresh();
  });
  q<HTMLButtonElement>('.cap-full').addEventListener('click', () => {
    model.useFullImage();
    refresh();
  });
  q<HTMLButtonElement>('.cap-close').addEventListener('click', () => close());

  // The download starts from the PNG callback of the click that asked for it.
  save.addEventListener('click', () => {
    const out = renderExport(model, o.image);
    if (!out || saving) return;
    saving = true;
    errorEl.hidden = true;
    refresh();
    canvasToPng(out).then(
      (blob) => {
        saving = false;
        if (open) refresh();
        o.save(blob);
      },
      () => {
        saving = false;
        if (!open) return;
        errorEl.hidden = false;
        refresh();
        o.failed?.();
      },
    );
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      model.undo();
      refresh();
    } else if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const items = [...root.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.disabled);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  root.addEventListener('keydown', onKeyDown);
  const onResize = () => fit();
  window.addEventListener('resize', onResize);
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  resizeObserver?.observe(stage);

  function close(): void {
    if (!open) return;
    open = false;
    window.removeEventListener('resize', onResize);
    resizeObserver?.disconnect();
    root.remove();
    o.closed();
  }

  document.body.append(root);
  fit();
  refresh();
  (root.querySelector<HTMLButtonElement>(`[data-tool="${model.tool}"]`) ?? save).focus();

  return {
    get isOpen() {
      return open;
    },
    close,
  };
}
