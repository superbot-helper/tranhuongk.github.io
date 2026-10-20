import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  SCREEN_DICTIONARY_SHA256,
  UltraViewerScreenDictionaryError,
  loadScreenDictionary,
  verifyScreenDictionary,
} from './screen-dictionary';

async function dictionaryError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(UltraViewerScreenDictionaryError);
    return (e as UltraViewerScreenDictionaryError).code;
  }
  throw new Error('expected UltraViewerScreenDictionaryError');
}

function writeTemp(bytes: Uint8Array): URL {
  const dir = mkdtempSync(join(tmpdir(), 'uv-dict-'));
  const path = join(dir, '8bit.dat');
  writeFileSync(path, bytes);
  return pathToFileURL(path);
}

// UltraViewerScreenDictionary.swift: size + SHA-256 pin.
describe('loadScreenDictionary', () => {
  test('loads the pinned 8bit.dat (112,640 bytes, dictionary ID 0x3da0bd10)', async () => {
    const dictionary = await loadScreenDictionary();
    expect(dictionary.length).toBe(112_640);
    expect(SCREEN_DICTIONARY_SHA256).toBe('9aa45789d9ff9d329a623a685d57b67e33c777019de9ce1f273f21860e4bfe6b');
    // zstd dictionary magic EC30A437, then little-endian dictionary ID.
    expect(Array.from(dictionary.subarray(0, 8))).toEqual([0x37, 0xa4, 0x30, 0xec, 0x10, 0xbd, 0xa0, 0x3d]);
  });

  test('a file differing in one byte is rejected as unexpectedResource', async () => {
    const tampered = (await loadScreenDictionary()).slice();
    tampered[50_000] = (tampered[50_000] ?? 0) ^ 0x01;
    expect(await dictionaryError(verifyScreenDictionary(tampered))).toBe('unexpectedResource');
    expect(await dictionaryError(loadScreenDictionary(writeTemp(tampered)))).toBe('unexpectedResource');
  });

  test('a file of the wrong length is rejected as unexpectedResource', async () => {
    const dictionary = await loadScreenDictionary();
    expect(await dictionaryError(verifyScreenDictionary(dictionary.subarray(1)))).toBe('unexpectedResource');
    expect(await dictionaryError(loadScreenDictionary(writeTemp(new Uint8Array())))).toBe('unexpectedResource');
  });

  test('a missing file is missingResource', async () => {
    const missing = new URL('./does-not-exist.dat', writeTemp(new Uint8Array()));
    expect(await dictionaryError(loadScreenDictionary(missing))).toBe('missingResource');
  });

  test('an HTTP failure is missingResource', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status: 404 });
    try {
      expect(await dictionaryError(loadScreenDictionary(new URL('https://example.invalid/8bit.dat')))).toBe(
        'missingResource',
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
