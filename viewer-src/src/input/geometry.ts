// Client point -> remote desktop point. The canvas shows the monitor crop of the
// decoded frame with object-fit: contain (letterboxed, centred).

export interface View {
  canvasRect: { left: number; top: number; width: number; height: number };
  /** Decoded frame size in pixels (used when `crop` has no size). */
  imageW: number;
  imageH: number;
  /** Displayed region of the decoded frame (the whole frame when no monitor is selected). */
  crop: { x: number; y: number; w: number; h: number };
  /** Remote virtual-desktop origin of the decoded frame (init part 9/10); negative for monitors left of the primary. */
  virtualLeft: number;
  virtualTop: number;
}

const INT32_MAX = 0x7fffffff;
const INT32_MIN = -0x80000000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Remote integer coordinates for a pointer at (clientX, clientY), or null when it is outside the
 * displayed image (letterbox bars included). While a button is held (`holding`) the point is
 * clamped into the image instead, so a drag that leaves it still ends on the edge.
 */
export function toRemote(
  clientX: number,
  clientY: number,
  v: View,
  holding = false,
): { x: number; y: number } | null {
  const { left, top, width, height } = v.canvasRect;
  const regionW = v.crop.w > 0 ? v.crop.w : v.imageW;
  const regionH = v.crop.h > 0 ? v.crop.h : v.imageH;
  if (![clientX, clientY, left, top, width, height, regionW, regionH].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0 || regionW <= 0 || regionH <= 0) return null;

  const scale = Math.min(width / regionW, height / regionH);
  const offsetX = (width - regionW * scale) / 2;
  const offsetY = (height - regionH * scale) / 2;
  // The epsilon keeps exact pixel centres from landing one pixel low through float error.
  const ix = (clientX - left - offsetX) / scale + 1e-9;
  const iy = (clientY - top - offsetY) / scale + 1e-9;
  const inside = ix >= 0 && ix < regionW && iy >= 0 && iy < regionH;
  if (!inside && !holding) return null;

  const px = clamp(Math.floor(ix), 0, regionW - 1);
  const py = clamp(Math.floor(iy), 0, regionH - 1);
  return {
    x: clamp(Math.floor(px + v.crop.x + v.virtualLeft), INT32_MIN, INT32_MAX),
    y: clamp(Math.floor(py + v.crop.y + v.virtualTop), INT32_MIN, INT32_MAX),
  };
}
