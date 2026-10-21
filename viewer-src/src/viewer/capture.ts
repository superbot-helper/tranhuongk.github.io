// Screenshot / recording helpers shared by the annotator, the recorder and the page: pure
// geometry and naming (ports of the MacViewer capture rules: RemoteCaptureEditorModel,
// RemoteVideoRecorder, RemoteCaptureController.captureName) plus the few DOM helpers that
// turn a canvas into a download. Captures always come from the decoded remote frame (the
// screen canvas, already cropped to the selected monitor), never from the browser window.

/** A rectangle in source (decoded frame) pixels. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export const RECORD_MAX_WIDTH = 1920;
export const RECORD_MAX_HEIGHT = 1080;
export const RECORD_FPS = 15;
/** Largest remote image the recorder accepts (Swift: invalidDimensions). */
export const RECORD_MAX_DIMENSION = 8192;
/** A selection smaller than this on either side cannot be exported. */
export const MIN_REGION = 2;
const FALLBACK_NAME = 'UltraViewer';
const MAX_NAME_CHARS = 60;

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/** Recording size: fit inside 1920×1080 keeping the aspect, never upscaled, even sides. Null if unusable. */
export function recordSize(width: number, height: number): { width: number; height: number } | null {
  const ok = (n: number) => Number.isFinite(n) && n > 0 && n <= RECORD_MAX_DIMENSION;
  if (!ok(width) || !ok(height)) return null;
  if (width <= RECORD_MAX_WIDTH && height <= RECORD_MAX_HEIGHT) return { width: even(width), height: even(height) };
  // Integer arithmetic keeps exact ratios (2560×1440) from losing a pixel to float noise.
  if (width * RECORD_MAX_HEIGHT >= height * RECORD_MAX_WIDTH) {
    return { width: RECORD_MAX_WIDTH, height: even((height * RECORD_MAX_WIDTH) / width) };
  }
  return { width: even((width * RECORD_MAX_HEIGHT) / height), height: RECORD_MAX_HEIGHT };
}

/** min(6 Mbps, max(500 kbps, w*h*3)). */
export function recordBitrate(width: number, height: number): number {
  return Math.min(6_000_000, Math.max(500_000, width * height * 3));
}

/** The rectangle spanned by two drag points, whichever way it was dragged. */
export function normalizeRegion(a: Point, b: Point): Region {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

export function isExportableRegion(r: Region | null): r is Region {
  return r !== null && r.w >= MIN_REGION && r.h >= MIN_REGION;
}

/** The pixels a selection exports: rounded outward, clipped to the image; null when nothing is left. */
export function exportBounds(r: Region, imageW: number, imageH: number): Region | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(imageW, Math.ceil(r.x + r.w));
  const y1 = Math.min(imageH, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Pen / rectangle line width in source pixels. */
export function strokeWidth(imageW: number, imageH: number): number {
  return Math.max(2, Math.min(imageW, imageH) / 350);
}

/** Marks kept by the annotator; adding one more drops the oldest. */
export const MAX_MARKS = 200;
/** Points kept per pen stroke; further points are ignored. */
export const MAX_POINTS_PER_STROKE = 50_000;

// Characters Windows/macOS/Linux reject in names, and C0/C1 controls.
// eslint-disable-next-line no-control-regex
const INVALID_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g;
// Zero-width and bidirectional overrides can disguise an extension.
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁩﻿]/g;

const pad = (n: number): string => String(n).padStart(2, '0');

/** `<máy> yyyy-MM-dd HH.mm.ss.<ext>` in local time; the machine name is made safe for a file name. */
export function captureFileName(machine: string, date: Date, ext: string): string {
  let safe = machine.replace(INVISIBLE_CHARS, '').replace(INVALID_NAME_CHARS, '-');
  safe = Array.from(safe).slice(0, MAX_NAME_CHARS).join('');
  safe = safe.replace(/^[\s.]+|[\s.]+$/g, '');
  if (safe === '') safe = FALLBACK_NAME;
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `${safe} ${stamp}.${ext}`;
}

/** An object URL is revoked this long after its download started. */
const REVOKE_DELAY_MS = 60_000;

/** Starts a download of a URL (a data URL needs no cleanup). Call it inside a click handler (Safari needs the user gesture). */
export function downloadUrl(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
}

/** Starts a download of `blob` (an object URL, revoked a minute later). Call it inside a click handler. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, name);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** A copy of the canvas pixels right now (the screen canvas keeps changing under the next frame). */
export function snapshotCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext('2d')?.drawImage(source, 0, 0);
  return copy;
}

/**
 * The canvas as a PNG data URL, produced synchronously so a download can start inside the click
 * that asked for it (Safari drops downloads started after an async step). Null if encoding failed.
 */
export function pngDataUrl(canvas: HTMLCanvasElement): string | null {
  try {
    const url = canvas.toDataURL('image/png');
    return url.startsWith('data:image/png') ? url : null;
  } catch {
    return null;
  }
}
