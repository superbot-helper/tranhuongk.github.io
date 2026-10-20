// Port of UltraViewerProtocol/UltraViewerScreenDictionary.swift.
// The desktop loads this trained Zstandard dictionary at startup. It is data,
// not Windows executable code; zstd consumes its bytes.
import { loadBinaryAsset } from './asset';

export const SCREEN_DICTIONARY_LENGTH = 112_640;
export const SCREEN_DICTIONARY_SHA256 = '9aa45789d9ff9d329a623a685d57b67e33c777019de9ce1f273f21860e4bfe6b';

const DEFAULT_URL = new URL('./8bit.dat', import.meta.url);

export type UltraViewerScreenDictionaryErrorCode = 'missingResource' | 'unexpectedResource';

export class UltraViewerScreenDictionaryError extends Error {
  readonly code: UltraViewerScreenDictionaryErrorCode;
  constructor(code: UltraViewerScreenDictionaryErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'UltraViewerScreenDictionaryError';
    this.code = code;
  }
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolves to `bytes` when length and SHA-256 match the pin; otherwise unexpectedResource. */
export async function verifyScreenDictionary(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length !== SCREEN_DICTIONARY_LENGTH) throw new UltraViewerScreenDictionaryError('unexpectedResource');
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  if (hex(digest) !== SCREEN_DICTIONARY_SHA256) throw new UltraViewerScreenDictionaryError('unexpectedResource');
  return bytes;
}

/** Fetches `8bit.dat` (the asset shipped with the viewer unless `url` is given) and verifies it. */
export async function loadScreenDictionary(url: URL = DEFAULT_URL): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await loadBinaryAsset(url);
  } catch (e) {
    throw new UltraViewerScreenDictionaryError('missingResource', { cause: e });
  }
  return verifyScreenDictionary(bytes);
}
