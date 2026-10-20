// Uint8Array <-> forge "binary string" (one char per byte). forge's util.binary.raw.encode is
// String.fromCharCode.apply(null, bytes), which overflows the call stack for one input of
// ~128 KiB (V8; less in JavaScriptCore) — and one WebSocket message (one Worker TCP read, e.g.
// the first screen frame) can be far larger. Encode in fixed slices instead.
const SLICE = 8192;

export function bytesToBinary(bytes: Uint8Array): string {
  if (bytes.length <= SLICE) return String.fromCharCode.apply(null, bytes as unknown as number[]);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += SLICE) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE) as unknown as number[]));
  }
  return parts.join('');
}

/** A per-character loop (no spread/apply), safe at any size. Chars above 0xff keep their low byte. */
export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
