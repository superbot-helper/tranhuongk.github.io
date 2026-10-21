import { describe, expect, test } from 'vitest';
import {
  FileOfferError,
  MAX_FILE_PART_SIZE,
  MAX_FILE_SIZE,
  decodeFileMessage,
  fileAckPayload,
  fileAcceptPayload,
  fileCancelPayload,
  fileChunkPayload,
  fileOfferPayload,
  newTransferId,
  validFileName,
} from './file-offer';
import { concat, enc, expectError, u8 } from './test-utils';

function doubleBytes(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, true);
  return out;
}

// Independent UTF-16LE encoder (the production one lives in utf16.ts).
function utf16(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out.push(unit & 0xff, unit >> 8);
  }
  return u8(...out);
}

const fileError = (fn: () => unknown, code: string): void => expectError(fn, FileOfferError, code);

// Ported from FileTransferOfferTests.swift. The host-side encoders
// (hostToViewer, host* helpers) and decodeViewerPayload / peerPayload are not
// part of the browser viewer and are not ported; their wire vectors are
// covered through the viewer-side payload builders below.
describe('file transfer offer (FileTransferOfferTests.swift)', () => {
  test('file offer from Windows decodes name and size', () => {
    expect(Array.from(doubleBytes(129_201))).toEqual([0, 0, 0, 0, 0x10, 0x8b, 0xff, 0x40]);
    const parts = [u8(13, 0), enc('30121899004712353684'), enc('test.txt'), doubleBytes(129_201)];
    expect(decodeFileMessage(parts)).toEqual({ type: 'offer', id: '30121899004712353684', name: 'test.txt', size: 129_201 });
    expect(decodeFileMessage(parts.slice(0, 3))).toBeNull();
    expect(decodeFileMessage([parts[0]!, parts[1]!, parts[2]!, u8(1, 2)])).toBeNull();
    expect(decodeFileMessage([parts[0]!, parts[1]!, parts[2]!, doubleBytes(-1)])).toBeNull();
  });

  test('file data from Windows carries a one-based offset', () => {
    const parts = [u8(15, 0), enc('30121899013807105853'), doubleBytes(32_001), new Uint8Array(32_000)];
    const chunk = decodeFileMessage(parts);
    expect(chunk).toMatchObject({ type: 'chunk', id: '30121899013807105853', offset: 32_001 });
    expect(chunk?.type === 'chunk' && chunk.data.length).toBe(32_000);
    expect(decodeFileMessage([parts[0]!, parts[1]!, doubleBytes(0), parts[3]!])).toBeNull();
  });

  test('Mac file commands are UTF-16 text', () => {
    const offer = fileOfferPayload('30121899012500967266', 'test.txt', 31);
    expect(offer.formatFlag).toBe(true);
    expect(offer.bytes).toEqual(utf16('13|||30121899012500967266|||test.txt|||31'));
    expect(fileAcceptPayload('1').bytes).toEqual(utf16('14|||1|||1'));
    expect(fileAckPayload('1').bytes).toEqual(utf16('21|||1'));
    expect(fileCancelPayload('1').bytes).toEqual(utf16('16|||1'));
    for (const m of [fileAcceptPayload('1'), fileAckPayload('1'), fileCancelPayload('1')]) expect(m.formatFlag).toBe(true);
  });

  test('Mac file data is an ASCII header and raw bytes', () => {
    const data = concat(u8(0, 0xff), enc('|||x'));
    const payload = fileChunkPayload('30121899014729763011', 32_001, data);
    expect(payload.bytes).toEqual(concat(enc('15|||30121899014729763011|||32001|||'), data));
    expect(payload.formatFlag).toBe(false);
  });

  test('file offers and offsets reject fractional, non-finite and invalid fields', () => {
    const id = enc('123');
    const name = enc('a.txt');
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, MAX_FILE_SIZE + 1]) {
      expect(decodeFileMessage([u8(13, 0), id, name, doubleBytes(invalid)])).toBeNull();
      expect(decodeFileMessage([u8(15, 0), id, doubleBytes(invalid), u8(1)])).toBeNull();
    }
    expect(decodeFileMessage([u8(13, 9), id, name, doubleBytes(1)])).toBeNull();
    expect(decodeFileMessage([u8(13, 0), enc('a|||b'), name, doubleBytes(1)])).toBeNull();
    expect(decodeFileMessage([u8(13, 0), id, u8(0xff), doubleBytes(1)])).not.toBeNull(); // Legacy ANSI fallback.
    expect(decodeFileMessage([u8(13, 0), id, enc('a\0b'), doubleBytes(1)])).toBeNull();
    expect(decodeFileMessage([u8(13, 0), id, enc('a|||b'), doubleBytes(1)])).toBeNull();
  });

  test('native host file names decode ANSI first (CP1252)', () => {
    const cafe = decodeFileMessage([u8(13, 0), enc('123'), u8(0x63, 0x61, 0x66, 0xe9), doubleBytes(3)]);
    expect(cafe).toMatchObject({ type: 'offer', name: 'café', size: 3 });
  });

  test('native host legacy chunk offsets are strict positive Int32LE', () => {
    const base = [u8(15, 0), enc('123')];
    const legacy = decodeFileMessage([...base, u8(1, 0x7d, 0, 0), u8(1)]);
    expect(legacy).toMatchObject({ type: 'chunk', id: '123', offset: 32_001 });
    expect(decodeFileMessage([...base, u8(0, 0, 0, 0), u8(1)])).toBeNull();
    expect(decodeFileMessage([...base, u8(0xff, 0xff, 0xff, 0xff), u8(1)])).toBeNull();
  });

  test('legacy ANSI file names that coincide with valid UTF-8 are not reinterpreted', () => {
    const offer = decodeFileMessage([u8(13, 0), enc('123'), u8(0xc3, 0xa9), doubleBytes(1)]);
    expect(offer).toMatchObject({ type: 'offer', name: 'Ã©' });
  });
});

// Extra coverage specific to the TypeScript port.
describe('file transfer (port extras)', () => {
  const id = enc('123');

  test('CP1252 0x80-0x9F matches Foundation windowsCP1252', () => {
    // Generated with swiftc on String(data:encoding:.windowsCP1252); undefined bytes are nil.
    const table: Record<number, number | null> = {
      0x80: 0x20ac, 0x81: null, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
      0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8d: null, 0x8e: 0x17d, 0x8f: null,
      0x90: null, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
      0x98: 0x2dc, 0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9d: null, 0x9e: 0x17e, 0x9f: 0x178,
    };
    for (const [byte, scalar] of Object.entries(table)) {
      const offer = decodeFileMessage([u8(13, 0), id, u8(0x61, Number(byte)), doubleBytes(1)]);
      if (scalar === null) {
        expect(offer, `byte 0x${Number(byte).toString(16)}`).toBeNull(); // Not UTF-8 either.
      } else {
        expect(offer).toMatchObject({ name: `a${String.fromCodePoint(scalar)}` });
      }
    }
    // 0xA0..0xFF are Latin-1 identical.
    const latin = Uint8Array.from({ length: 96 }, (_, i) => 0xa0 + i);
    expect(decodeFileMessage([u8(13, 0), id, latin, doubleBytes(1)])).toMatchObject({
      name: String.fromCharCode(...latin),
    });
  });

  test('UTF-8 is the fallback when CP1252 has an undefined byte', () => {
    // U+0441 is D1 81 in UTF-8; 0x81 is undefined in CP1252.
    expect(decodeFileMessage([u8(13, 0), id, u8(0xd1, 0x81), doubleBytes(1)])).toMatchObject({ name: 'с' });
    // Every byte defined in CP1252 stays CP1252 even when the bytes happen to be valid UTF-8 (E6 97 A5 = U+65E5).
    // Bytes all defined in CP1252 stay CP1252 even when they happen to be valid UTF-8 (E6 97 A5 = U+65E5).
    expect(decodeFileMessage([u8(13, 0), id, concat(enc('a'), u8(0xe6, 0x97, 0xa5), enc('.txt')), doubleBytes(1)])).toMatchObject({
      name: 'aæ—¥.txt',
    });
  });

  test('offer limits: size 0 and the maximum are valid; names are bounded to 1024 UTF-8 bytes', () => {
    expect(decodeFileMessage([u8(13, 0), id, enc('a'), doubleBytes(0)])).toMatchObject({ size: 0 });
    expect(decodeFileMessage([u8(13, 0), id, enc('a'), doubleBytes(MAX_FILE_SIZE)])).toMatchObject({ size: MAX_FILE_SIZE });
    expect(decodeFileMessage([u8(13, 0), id, enc('a'.repeat(1024)), doubleBytes(1)])).not.toBeNull();
    expect(decodeFileMessage([u8(13, 0), id, enc('a'.repeat(1025)), doubleBytes(1)])).toBeNull();
    expect(decodeFileMessage([u8(13, 0), id, new Uint8Array(), doubleBytes(1)])).toBeNull();
    expect(decodeFileMessage([u8(13, 0), id, enc('a\x7fb'), doubleBytes(1)])).toBeNull();
    expect(decodeFileMessage([u8(13, 0), id, enc('a\tb'), doubleBytes(1)])).toBeNull();
    expect(decodeFileMessage([u8(13), id, enc('a'), doubleBytes(-0)])).toMatchObject({ size: 0 });
  });

  test('identifiers are 1..64 of [0-9A-Za-z_-]', () => {
    const offerWith = (idBytes: Uint8Array) => decodeFileMessage([u8(13, 0), idBytes, enc('a'), doubleBytes(1)]);
    expect(offerWith(enc('Az09_-'))).toMatchObject({ id: 'Az09_-' });
    expect(offerWith(enc('a'.repeat(64)))).not.toBeNull();
    expect(offerWith(enc('a'.repeat(65)))).toBeNull();
    expect(offerWith(new Uint8Array())).toBeNull();
    expect(offerWith(enc('a b'))).toBeNull();
    expect(offerWith(enc('a.b'))).toBeNull();
    expect(offerWith(u8(0x61, 0xc3, 0xa9))).toBeNull();
  });

  test('chunk bounds: data <= 32000, exactly four parts, offsets Double8 or Int32', () => {
    expect(decodeFileMessage([u8(15, 0), id, doubleBytes(1), new Uint8Array(32_000)])).not.toBeNull();
    expect(decodeFileMessage([u8(15, 0), id, doubleBytes(1), new Uint8Array(32_001)])).toBeNull();
    expect(decodeFileMessage([u8(15, 0), id, doubleBytes(1)])).toBeNull();
    expect(decodeFileMessage([u8(15, 0), id, doubleBytes(1), u8(1), u8(2)])).toBeNull();
    expect(decodeFileMessage([u8(15), id, doubleBytes(MAX_FILE_SIZE), u8(1)])).toMatchObject({ offset: MAX_FILE_SIZE });
    expect(decodeFileMessage([u8(15, 0), id, u8(0xff, 0xff, 0xff, 0x7f), u8(1)])).toMatchObject({ offset: 0x7fffffff });
    expect(decodeFileMessage([u8(15, 0), id, u8(0, 0, 0, 0x80), u8(1)])).toBeNull();
    expect(decodeFileMessage([u8(15, 0), id, u8(1, 0, 0), u8(1)])).toBeNull();
    expect(decodeFileMessage([u8(15, 0), id, doubleBytes(1.5), u8(1)])).toBeNull();
  });

  test('accept, ack and cancel from the host', () => {
    expect(decodeFileMessage([u8(14, 0), id, u8(1, 0, 0, 0)])).toEqual({ type: 'accept', id: '123', offset: 1 });
    expect(decodeFileMessage([u8(14), id, u8(1, 0, 0, 0)])).toEqual({ type: 'accept', id: '123', offset: 1 });
    expect(decodeFileMessage([u8(14, 0), id, u8(2, 0, 0, 0)])).toBeNull(); // Resume is not implemented.
    expect(decodeFileMessage([u8(14, 0), id, u8(1, 0, 0)])).toBeNull();
    expect(decodeFileMessage([u8(14, 0), id])).toBeNull();
    expect(decodeFileMessage([u8(14, 0), id, u8(1, 0, 0, 0), u8(0)])).toBeNull();
    expect(decodeFileMessage([u8(16, 0), id])).toEqual({ type: 'cancel', id: '123' });
    expect(decodeFileMessage([u8(21, 0), id])).toEqual({ type: 'ack', id: '123' });
    expect(decodeFileMessage([u8(21), id])).toEqual({ type: 'ack', id: '123' });
    expect(decodeFileMessage([u8(16, 0), id, u8(0)])).toBeNull();
    expect(decodeFileMessage([u8(21, 0), enc('a|||b')])).toBeNull();
    expect(decodeFileMessage([u8(21, 0)])).toBeNull();
  });

  test('unrelated or ill-formed commands return null', () => {
    expect(decodeFileMessage([])).toBeNull();
    expect(decodeFileMessage([new Uint8Array(), id])).toBeNull();
    expect(decodeFileMessage([u8(12, 0), id])).toBeNull();
    expect(decodeFileMessage([u8(21, 1), id])).toBeNull();
    expect(decodeFileMessage([u8(21, 0, 0), id])).toBeNull();
  });

  test('validFileName follows the Swift isValid rules', () => {
    expect(validFileName('test.txt')).toBe(true);
    expect(validFileName('Báo cáo 日本語 😀.txt')).toBe(true);
    expect(validFileName('')).toBe(false);
    expect(validFileName('a|||b')).toBe(false);
    expect(validFileName('a\0b')).toBe(false);
    expect(validFileName('a\nb')).toBe(false);
    expect(validFileName('a\x7fb')).toBe(false);
    expect(validFileName('a'.repeat(1024))).toBe(true);
    expect(validFileName('a'.repeat(1025))).toBe(false);
    expect(validFileName('日'.repeat(341))).toBe(true); // 1023 bytes
    expect(validFileName('日'.repeat(342))).toBe(false); // 1026 bytes
  });

  test('viewer payload builders validate their input', () => {
    fileError(() => fileOfferPayload('', 'a.txt', 1), 'invalidTransferId');
    fileError(() => fileOfferPayload('a|||b', 'a.txt', 1), 'invalidTransferId');
    fileError(() => fileOfferPayload('1', 'a|||b.txt', 1), 'invalidFileName');
    fileError(() => fileOfferPayload('1', '', 1), 'invalidFileName');
    fileError(() => fileOfferPayload('1', 'a.txt', -1), 'invalidSize');
    fileError(() => fileOfferPayload('1', 'a.txt', 1.5), 'invalidSize');
    fileError(() => fileOfferPayload('1', 'a.txt', MAX_FILE_SIZE + 1), 'invalidSize');
    expect(fileOfferPayload('1', 'Báo cáo.txt', 0).bytes).toEqual(utf16('13|||1|||Báo cáo.txt|||0'));
    expect(fileOfferPayload('1', 'a.txt', MAX_FILE_SIZE).bytes).toEqual(utf16(`13|||1|||a.txt|||${MAX_FILE_SIZE}`));
    fileError(() => fileAcceptPayload('bad id'), 'invalidTransferId');
    fileError(() => fileAckPayload(''), 'invalidTransferId');
    fileError(() => fileCancelPayload('x'.repeat(65)), 'invalidTransferId');
    fileError(() => fileChunkPayload('bad id', 1, new Uint8Array()), 'invalidTransferId');
    fileError(() => fileChunkPayload('1', 0, new Uint8Array()), 'invalidOffset');
    fileError(() => fileChunkPayload('1', 1.5, new Uint8Array()), 'invalidOffset');
    fileError(() => fileChunkPayload('1', MAX_FILE_SIZE + 1, new Uint8Array()), 'invalidOffset');
    fileError(() => fileChunkPayload('1', 1, new Uint8Array(MAX_FILE_PART_SIZE + 1)), 'chunkTooLarge');
    expect(fileChunkPayload('1', 1, new Uint8Array(MAX_FILE_PART_SIZE)).bytes.length).toBe(enc('15|||1|||1|||').length + 32_000);
    expect(fileChunkPayload('1', 1, new Uint8Array()).bytes).toEqual(enc('15|||1|||1|||'));
  });

  test('error messages never include the file name', () => {
    let thrown: unknown;
    try {
      fileOfferPayload('1', 'secret|||name.txt', 1);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as FileOfferError).message).toBe('invalidFileName');
  });

  test('newTransferId is "3" + 19 random digits', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const value = newTransferId();
      expect(value).toMatch(/^3[0-9]{19}$/);
      seen.add(value);
    }
    expect(seen.size).toBe(200);
  });
});
