// Spike-page check of the screen pipeline in a real browser (Task 7 replaces the
// spike): pinned 8bit.dat, zstd wasm with the dictionary, and a renderer frame
// whose JPEG atlas goes through createImageBitmap + canvas.
import { loadScreenDictionary } from '../codec/screen-dictionary';
import { ZstdScreenDecoder } from '../codec/zstd-decoder';
import { bgr24FromRGBA } from '../proto/pixels';
import { decodeFrameMessage } from '../proto/screen-message';
import { ModernScreenRenderer } from '../proto/screen-renderer';

// Independent zstd CLI -3 -D 8bit.dat output (ZstdScreenDecoderTests.swift).
const DICTIONARY_FIXTURE = 'KLUv/QdYEL2gPS0BAOhNYWNWaWV3ZXIgZGljdGlvbmFyeSBmaXh0dXJlCgEA0Qz4ygnbOEGJ';
// Native UVC 2×2 JPEG fixture (ModernScreenTests.swift).
const JPEG_FIXTURE =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8KP8Ahr79rP8A6Oh/aJ/8PZ8Sv/mmooor+fz6xdPl/wC4z//Z';
// TurboJPEG reference for the atlas walk, BGR (ModernScreenTests.swift).
const NATIVE_BGR = [24, 54, 59, 161, 191, 196, 24, 54, 59, 161, 191, 196];

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function words(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  values.forEach((v, i) => {
    out[i * 2] = v & 0xff;
    out[i * 2 + 1] = (v >> 8) & 0xff;
  });
  return out;
}

export async function runScreenSelfTest(log: (line: string) => void): Promise<boolean> {
  const dictionary = await loadScreenDictionary();
  log(`8bit.dat OK (${dictionary.length} bytes, SHA-256 pinned)`);

  const decoder = await ZstdScreenDecoder.create(dictionary);
  const text = new TextDecoder().decode(decoder.append(fromBase64(DICTIONARY_FIXTURE)));
  decoder.finish();
  decoder.dispose();
  const zstdOK = text === 'MacViewer dictionary fixture\n'.repeat(100);
  log(`zstd wasm + dictionary: ${zstdOK ? 'OK' : 'MISMATCH'}`);

  const renderer = await ModernScreenRenderer.create({
    width: 4,
    height: 1,
    tileSize: 1,
    displayColors: 2,
    lastFrameNumber: 0,
    dictionary,
  });
  const empty = new Uint8Array();
  const frame = decodeFrameMessage([
    Uint8Array.of(1), empty, empty, empty, Uint8Array.of(1, 0, 0, 0), empty, empty,
    fromBase64(JPEG_FIXTURE), words([0, 0, 3, 1, 3, 0, 1, 1]), empty, empty,
  ]);
  const bitmap = await renderer.apply(frame);
  renderer.dispose();
  const bgr = Array.from(bgr24FromRGBA(bitmap.rgba, bitmap.width, bitmap.height));
  const jpegOK = bgr.length === NATIVE_BGR.length && bgr.every((v, i) => Math.abs(v - (NATIVE_BGR[i] ?? -100)) <= 8);
  log(`renderer JPEG atlas (browser decoder): ${jpegOK ? 'OK' : 'MISMATCH'} [${bgr.join(',')}]`);
  return zstdOK && jpegOK;
}
