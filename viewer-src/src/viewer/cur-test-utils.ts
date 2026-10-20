// Test fixtures shared by cur-decode and cursor-layer tests (ports of the Swift cursorFixture/dibFixture).

export function long(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Swift cursorFixture: one-image CUR file around `resource`. */
export function curFile(resource: Uint8Array | number[], width: number, height: number, hotX = 0, hotY = 0): Uint8Array {
  const data = [0, 0, 2, 0, 1, 0, width & 0xff, height & 0xff, 0, 0, hotX & 0xff, hotX >> 8, hotY & 0xff, hotY >> 8];
  return Uint8Array.from([...data, ...long(resource.length), ...long(22), ...resource]);
}

/** Swift dibFixture: BITMAPINFOHEADER(40), planes 1, compression 0, doubled height. */
export function dib(o: {
  width: number;
  height: number;
  bits: number;
  topDown?: boolean;
  colors?: number[];
  colorsUsed?: number;
  pixelRows: number[];
  maskRows: number[];
}): number[] {
  const doubled = (o.topDown ? -2 : 2) * o.height;
  return [
    ...long(40), ...long(o.width), ...long(doubled >>> 0),
    1, 0, o.bits & 0xff, o.bits >> 8,
    ...long(0), ...long(o.pixelRows.length), ...long(0), ...long(0), ...long(o.colorsUsed ?? 0), ...long(0),
    ...(o.colors ?? []), ...o.pixelRows, ...o.maskRows,
  ];
}

/** PNG signature + IHDR only: enough for the geometry check; pixels come from an injected decoder. */
export function pngStub(width: number, height: number): number[] {
  const be = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  return [137, 80, 78, 71, 13, 10, 26, 10, ...be(13), 0x49, 0x48, 0x44, 0x52, ...be(width), ...be(height), 8, 6, 0, 0, 0, 0, 0, 0, 0];
}
