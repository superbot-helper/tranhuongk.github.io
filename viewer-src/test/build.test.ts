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
    expect(read('THIRD_PARTY_NOTICES.md')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  test('emits the zstd wasm and the 8bit.dat dictionary as assets', () => {
    const files = walk(outDir);
    expect(files.filter((f) => /^assets\/zstd-[^/]+\.wasm$/.test(f))).toHaveLength(1);
    expect(files.filter((f) => /^assets\/8bit-[^/]+\.dat$/.test(f))).toHaveLength(1);
  });

  test('emits the audio worklet module and the g722 wasm as assets, none starting with _', () => {
    const files = walk(outDir);
    expect(files.filter((f) => /^assets\/g722-[^/]+\.wasm$/.test(f))).toHaveLength(1);
    const worklets = files.filter((f) => /^assets\/audio-worklet-[^/]+\.js$/.test(f));
    expect(worklets).toHaveLength(1);
    expect(read(worklets[0]!)).toContain('registerProcessor');
    expect(files.filter((f) => f.split('/').some((s) => s.startsWith('_')))).toEqual([]);
  });

  test('bundles Be Vietnam Pro (woff2, latin + vietnamese) and requests no external font', () => {
    const files = walk(outDir);
    const fonts = files.filter((f) => /^assets\/be-vietnam-pro-[^/]+\.woff2$/.test(f));
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.some((f) => f.includes('vietnamese'))).toBe(true);
    expect(fonts.some((f) => f.includes('latin'))).toBe(true);
    // Only the four weights in use, no woff fallbacks or other subsets.
    expect(fonts.every((f) => /-(latin|vietnamese)-(400|500|600|700)-normal-/.test(f))).toBe(true);
    expect(files.filter((f) => /\.(woff|ttf|otf)$/.test(f))).toEqual([]);
    const html = read('index.html');
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).not.toMatch(/<link[^>]+href="https?:\/\//);
    for (const css of files.filter((f) => f.endsWith('.css'))) {
      expect(read(css), css).not.toMatch(/url\(\s*['"]?(https?:)?\/\//);
    }
  });
});
