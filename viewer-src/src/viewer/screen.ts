// The remote screen canvas. It holds ONLY the selected monitor's crop of the decoded frame,
// at native pixel size; CSS scales it: "fit" = contain-fitted into the viewport (letterboxed),
// "actual" = 1 remote pixel per CSS pixel inside the scrollable viewport. In both modes the
// canvas content box has the crop's aspect ratio or is contain-fitted, which is what
// input/geometry.ts assumes.
import type { View } from '../input/geometry';
import type { ScreenBitmap } from '../proto/screen-renderer';

export type ScaleMode = 'fit' | 'actual';

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class ScreenView {
  private readonly context: CanvasRenderingContext2D | null;
  private frameW = 0;
  private frameH = 0;
  private virtualLeft = 0;
  private virtualTop = 0;
  /** Null: the whole decoded frame. */
  private selected: Crop | null = null;
  private mode: ScaleMode = 'fit';
  private last: ScreenBitmap | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly viewport: HTMLElement,
  ) {
    this.context = canvas.getContext('2d');
    this.applyScale();
  }

  get scale(): ScaleMode {
    return this.mode;
  }

  /** Decoded frame size and its virtual-desktop origin (init part 9/10). */
  setGeometry(width: number, height: number, virtualLeft: number, virtualTop: number): void {
    this.frameW = width;
    this.frameH = height;
    this.virtualLeft = virtualLeft;
    this.virtualTop = virtualTop;
    this.resize();
  }

  /** Decoded-pixel region to show; null for the whole frame. */
  setCrop(crop: Crop | null): void {
    this.selected = crop;
    this.resize();
    this.redraw();
  }

  setScale(mode: ScaleMode): void {
    this.mode = mode;
    this.applyScale();
  }

  draw(bitmap: ScreenBitmap): void {
    this.last = bitmap;
    if (bitmap.width !== this.frameW || bitmap.height !== this.frameH) {
      // The renderer is the source of truth for the frame size.
      this.frameW = bitmap.width;
      this.frameH = bitmap.height;
      this.resize();
    }
    this.paint(bitmap);
  }

  /** Forget the last frame (session closed); the canvas keeps showing it until the next one. */
  forget(): void {
    this.last = null;
  }

  view(): View {
    const r = this.canvas.getBoundingClientRect();
    return {
      canvasRect: { left: r.left, top: r.top, width: r.width, height: r.height },
      imageW: this.frameW,
      imageH: this.frameH,
      crop: this.crop(),
      virtualLeft: this.virtualLeft,
      virtualTop: this.virtualTop,
    };
  }

  private crop(): Crop {
    return this.selected ?? { x: 0, y: 0, w: this.frameW, h: this.frameH };
  }

  private redraw(): void {
    if (this.last) this.paint(this.last);
  }

  private paint(bitmap: ScreenBitmap): void {
    if (!this.context) return;
    const c = this.crop();
    const pixels = bitmap.rgba as Uint8ClampedArray<ArrayBuffer>;
    // Dirty-rect putImageData copies only the crop, placed at the canvas origin.
    this.context.putImageData(new ImageData(pixels, bitmap.width, bitmap.height), -c.x, -c.y, c.x, c.y, c.w, c.h);
  }

  private resize(): void {
    const c = this.crop();
    if (c.w <= 0 || c.h <= 0) return;
    if (this.canvas.width !== c.w) this.canvas.width = c.w;
    if (this.canvas.height !== c.h) this.canvas.height = c.h;
    this.applyScale();
  }

  private applyScale(): void {
    const s = this.canvas.style;
    this.viewport.dataset.scale = this.mode;
    if (this.mode === 'fit') {
      s.width = '100%';
      s.height = '100%';
    } else {
      s.width = `${this.canvas.width}px`;
      s.height = `${this.canvas.height}px`;
    }
  }
}
