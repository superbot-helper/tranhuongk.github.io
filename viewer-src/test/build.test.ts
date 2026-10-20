import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const outDir = fileURLToPath(new URL('../../viewer', import.meta.url));

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(join(dir, name)).isDirectory() ? walk(join(dir, name), rel) : [rel];
  });
}

function read(rel: string): string {
  return readFileSync(join(outDir, rel), 'utf8');
}

// Runs against the built output; use `npm run test:build` (builds first).
describe.skipIf(!existsSync(join(outDir, 'index.html')))('build output', () => {
  test('build output is Jekyll-safe and noindex', () => {
    const files = walk(outDir);
    expect(files).toContain('index.html');
    expect(files.filter((f) => f.split('/').some((s) => s.startsWith('_')))).toEqual([]);
    expect(read('index.html')).toContain('<meta name="robots" content="noindex,nofollow">');
  });

  test('ships third-party notices', () => {
    const files = walk(outDir);
    expect(files).toContain('THIRD_PARTY_NOTICES.md');
    expect(read('THIRD_PARTY_NOTICES.md')).toContain('MIT License');
    expect(read('THIRD_PARTY_NOTICES.md')).toContain('For Zstandard software');
  });

  test('emits the zstd wasm and the 8bit.dat dictionary as assets', () => {
    const files = walk(outDir);
    expect(files.filter((f) => /^assets\/zstd-[^/]+\.wasm$/.test(f))).toHaveLength(1);
    expect(files.filter((f) => /^assets\/8bit-[^/]+\.dat$/.test(f))).toHaveLength(1);
  });
});
