// Test-only helpers. Not imported by production code.
import { expect } from 'vitest';

export function u8(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

export function rep(byte: number, count: number): Uint8Array {
  return new Uint8Array(count).fill(byte);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Cut `bytes` at the given ascending offsets; returns cuts.length + 1 chunks. */
export function splitAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const cut of cuts) {
    chunks.push(bytes.slice(start, cut));
    start = cut;
  }
  chunks.push(bytes.slice(start));
  return chunks;
}

export function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Assert `fn` throws an instance of `type` whose `code` equals `code`. */
export function expectError(
  fn: () => unknown,
  type: new (...args: never[]) => Error & { code: string },
  code: string,
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected ${type.name}(${code}) to be thrown`).toBeInstanceOf(type);
  expect((thrown as { code: string }).code).toBe(code);
}
