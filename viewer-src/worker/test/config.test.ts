// wrangler.toml guard: Workers Logs include request headers and client IPs, so persistent
// observability must stay explicitly off.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('wrangler.toml disables observability explicitly', () => {
  const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.toml'), 'utf8');
  const lines = toml.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter((l) => l !== '');
  const at = lines.indexOf('[observability]');
  expect(at).toBeGreaterThanOrEqual(0);
  expect(lines[at + 1]).toBe('enabled = false');
  expect(lines.filter((l) => /^\[.*observability.*\]$/.test(l))).toEqual(['[observability]']);
});
