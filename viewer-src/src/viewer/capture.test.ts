import { describe, expect, test } from 'vitest';
import {
  captureFileName,
  exportBounds,
  isExportableRegion,
  normalizeRegion,
  recordBitrate,
  recordSize,
  strokeWidth,
} from './capture';

describe('recordSize', () => {
  test.each([
    [1920, 1080, 1920, 1080],
    [2560, 1440, 1920, 1080],
    [3840, 2160, 1920, 1080],
    [1366, 768, 1366, 768],
    [801, 601, 800, 600],
    [640, 480, 640, 480],
    [1921, 1081, 1918, 1080],
    [3000, 500, 1920, 320],
    [500, 3000, 180, 1080],
    [1, 1, 2, 2],
  ])('%d×%d -> %d×%d (aspect kept, even, never upscaled)', (w, h, ew, eh) => {
    expect(recordSize(w, h)).toEqual({ width: ew, height: eh });
  });

  test('rejects empty and absurd sizes', () => {
    expect(recordSize(0, 100)).toBeNull();
    expect(recordSize(100, -1)).toBeNull();
    expect(recordSize(8193, 100)).toBeNull();
    expect(recordSize(100, 8193)).toBeNull();
    expect(recordSize(Number.NaN, 100)).toBeNull();
    expect(recordSize(8192, 8192)).not.toBeNull();
  });
});

describe('recordBitrate', () => {
  test('min(6 Mbps, max(500 kbps, w*h*3))', () => {
    expect(recordBitrate(1920, 1080)).toBe(6_000_000);
    expect(recordBitrate(1366, 768)).toBe(3_147_264);
    expect(recordBitrate(640, 480)).toBe(921_600);
    expect(recordBitrate(320, 240)).toBe(500_000);
    expect(recordBitrate(2, 2)).toBe(500_000);
  });
});

describe('normalizeRegion / exportBounds', () => {
  test('a reverse drag is normalized', () => {
    expect(normalizeRegion({ x: 128, y: 32 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, w: 128, h: 32 });
    expect(normalizeRegion({ x: 10, y: 50 }, { x: 4, y: 20 })).toEqual({ x: 4, y: 20, w: 6, h: 30 });
  });

  test('a region under 2×2 is not exportable', () => {
    expect(isExportableRegion(null)).toBe(false);
    expect(isExportableRegion({ x: 0, y: 0, w: 1.9, h: 40 })).toBe(false);
    expect(isExportableRegion({ x: 0, y: 0, w: 40, h: 1 })).toBe(false);
    expect(isExportableRegion({ x: 0, y: 0, w: 2, h: 2 })).toBe(true);
  });

  test('exportBounds rounds outward and stays inside the image', () => {
    expect(exportBounds({ x: 10.4, y: 5.6, w: 20.2, h: 3.1 }, 100, 50)).toEqual({ x: 10, y: 5, w: 21, h: 4 });
    expect(exportBounds({ x: -5, y: -5, w: 30, h: 30 }, 100, 50)).toEqual({ x: 0, y: 0, w: 25, h: 25 });
    expect(exportBounds({ x: 90, y: 40, w: 30, h: 30 }, 100, 50)).toEqual({ x: 90, y: 40, w: 10, h: 10 });
    expect(exportBounds({ x: 200, y: 0, w: 10, h: 10 }, 100, 50)).toBeNull();
  });
});

describe('strokeWidth', () => {
  test('max(2, min(w,h)/350) source pixels', () => {
    expect(strokeWidth(128, 64)).toBe(2);
    expect(strokeWidth(1920, 1080)).toBeCloseTo(1080 / 350, 10);
    expect(strokeWidth(1920, 1080)).toBe(3.0857142857142859);
    expect(strokeWidth(3840, 2160)).toBeCloseTo(2160 / 350, 10);
    expect(strokeWidth(500, 5000)).toBe(2);
    expect(strokeWidth(7000, 700)).toBe(2);
    expect(strokeWidth(7000, 1400)).toBe(4);
  });
});

describe('captureFileName', () => {
  const date = new Date(2026, 9, 21, 7, 5, 9); // local time: 2026-10-21 07:05:09

  test('<máy> yyyy-MM-dd HH.mm.ss.<ext> in local time', () => {
    expect(captureFileName('PC-Văn phòng', date, 'png')).toBe('PC-Văn phòng 2026-10-21 07.05.09.png');
    expect(captureFileName('PC', date, 'mp4')).toBe('PC 2026-10-21 07.05.09.mp4');
    expect(captureFileName('PC', new Date(2026, 0, 2, 23, 59, 0), 'webm')).toBe('PC 2026-01-02 23.59.00.webm');
  });

  test('characters invalid in file names and control characters become "-"', () => {
    expect(captureFileName('a/b\\c:d*e?f"g<h>i|j', date, 'png')).toBe('a-b-c-d-e-f-g-h-i-j 2026-10-21 07.05.09.png');
    expect(captureFileName('x\u0000y\u001fz\u007fw\n', date, 'png')).toBe('x-y-z-w- 2026-10-21 07.05.09.png');
  });

  test('bidi/zero-width controls are dropped, dots and spaces trimmed, empty falls back', () => {
    expect(captureFileName('‮evil​', date, 'png')).toBe('evil 2026-10-21 07.05.09.png');
    expect(captureFileName('  ..name.. ', date, 'png')).toBe('name 2026-10-21 07.05.09.png');
    expect(captureFileName('', date, 'png')).toBe('UltraViewer 2026-10-21 07.05.09.png');
    expect(captureFileName('...', date, 'png')).toBe('UltraViewer 2026-10-21 07.05.09.png');
  });

  test('long names are cut to 60 characters', () => {
    const name = captureFileName('é'.repeat(100), date, 'png');
    expect(name).toBe(`${'é'.repeat(60)} 2026-10-21 07.05.09.png`);
  });
});
