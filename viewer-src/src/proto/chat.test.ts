import { describe, expect, test } from 'vitest';
import { ChatError, MAX_CHAT_TEXT_BYTES, chatMessagePayload, chatTypingPayload, decodeChat } from './chat';
import { decodeMultipart, encodeMultipart } from './multipart';
import { concat, expectError, u8 } from './test-utils';

// Independent UTF-16LE encoder (the production one lives in utf16.ts).
function utf16(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out.push(unit & 0xff, unit >> 8);
  }
  return u8(...out);
}

// Local resource budget the Swift hostToViewer applies; the host side is not
// ported, so these helpers rebuild the host bytes the Swift tests compare to.
const chatLimits = {
  maximumPayloadLength: MAX_CHAT_TEXT_BYTES + 10,
  maximumPartLength: MAX_CHAT_TEXT_BYTES,
  maximumPartCount: 2,
};
const hostMessage = (text: string): Uint8Array => encodeMultipart([u8(12, 0), utf16(text)], chatLimits);
const hostTyping = (typing: boolean): Uint8Array => encodeMultipart([u8(typing ? 29 : 30, 0)], chatLimits);

const chatError = (fn: () => unknown, code: string): void => expectError(fn, ChatError, code);

// Ported from ChatProtocolTests.swift. Host-side encoders/decoders
// (hostToViewer*, decodeHostPayload) are not part of the browser viewer; the
// host wire bytes are rebuilt from the same vectors with encodeMultipart.
describe('chat protocol (ChatProtocolTests.swift)', () => {
  test('chat messages use independent direction-specific fixtures', () => {
    // A + Vietnamese U+1EBF + U+1F642.
    const text = 'Aế🙂';
    const viewer = chatMessagePayload(text);
    expect(viewer.formatFlag).toBe(true);
    expect(viewer.bytes).toEqual(u8(0x31, 0, 0x32, 0, 0x7c, 0, 0x7c, 0, 0x7c, 0, 0x41, 0, 0xbf, 0x1e, 0x3d, 0xd8, 0x42, 0xde));
    const host = hostMessage(text);
    expect(host).toEqual(u8(2, 0, 0, 0, 12, 0, 8, 0, 0, 0, 0x41, 0, 0xbf, 0x1e, 0x3d, 0xd8, 0x42, 0xde));
    expect(decodeChat(decodeMultipart(host))).toEqual({ type: 'message', text });
  });

  test('chat typing commands have no text or additional parts', () => {
    for (const typing of [false, true]) {
      const viewer = chatTypingPayload(typing);
      expect(viewer.formatFlag).toBe(true);
      expect(viewer.bytes).toEqual(typing ? u8(0x32, 0, 0x39, 0) : u8(0x33, 0, 0x30, 0));
      const host = hostTyping(typing);
      expect(host).toEqual(u8(2, 0, 0, 0, typing ? 29 : 30, 0));
      expect(decodeChat(decodeMultipart(host))).toEqual({ type: 'typing', typing });
    }
    expect(decodeChat([u8(20)])).toBeNull();
    expect(decodeChat([])).toBeNull();
  });

  test('Windows host chat uses an Int16 command despite the one-byte helper name', () => {
    // VFunction.Get1ByteFromNumber(u1) calls BitConverter.GetBytes(Int16): 0c 00.
    const windowsMessage = u8(2, 0, 0, 0, 0x0c, 0, 8, 0, 0, 0, 0x74, 0, 0x65, 0, 0x73, 0, 0x74, 0);
    expect(decodeChat(decodeMultipart(windowsMessage))).toEqual({ type: 'message', text: 'test' });
    for (const [command, expected] of [[29, true], [30, false]] as const) {
      const windowsTyping = u8(2, 0, 0, 0, command, 0);
      expect(decodeChat(decodeMultipart(windowsTyping))).toEqual({ type: 'typing', typing: expected });
    }
    // Older MacViewer peers emitted a byte command; they remain compatible.
    expect(decodeChat([u8(12), u8(0x41, 0)])).toEqual({ type: 'message', text: 'A' });
    expect(decodeChat([u8(29)])).toEqual({ type: 'typing', typing: true });
    expect(decodeChat([u8(30)])).toEqual({ type: 'typing', typing: false });
  });

  test('chat preserves newlines and delimiters only where the wire supports them', () => {
    const text = 'Hello\r\nXin chào\t世界';
    expect(chatMessagePayload(text).bytes).toEqual(utf16(`12|||${text}`));
    expect(decodeChat(decodeMultipart(hostMessage(text)))).toEqual({ type: 'message', text });
    chatError(() => chatMessagePayload('a|||b'), 'unsupportedDelimiter');
    expect(decodeChat(decodeMultipart(hostMessage('a|||b')))).toEqual({ type: 'message', text: 'a|||b' });
  });

  test('chat rejects malformed encoding, parts and text budgets', () => {
    for (const bytes of [u8(0x41), u8(0, 0xd8), u8(0, 0xdc), u8(0, 0xd8, 0x41, 0)]) {
      chatError(() => decodeChat([u8(12), bytes]), 'invalidEncoding');
    }
    const malformed: Uint8Array[][] = [
      [u8(12)],
      [u8(12, 1), new Uint8Array()],
      [u8(12, 0, 0), new Uint8Array()],
      [u8(29), new Uint8Array()],
      [u8(12), new Uint8Array(), new Uint8Array()],
    ];
    for (const parts of malformed) chatError(() => decodeChat(parts), 'malformedMessage');
    for (const text of ['hello\0world', '\u001btext']) chatError(() => chatMessagePayload(text), 'invalidText');
    // Same policy on receive: a NUL (BSTR terminator) in a well-formed UTF-16 text.
    chatError(() => decodeChat([u8(12), utf16('a\0b')]), 'invalidText');
    const boundary = 'a'.repeat(MAX_CHAT_TEXT_BYTES / 2);
    expect(hostMessage(boundary).length).toBe(MAX_CHAT_TEXT_BYTES + 10);
    expect(chatMessagePayload(boundary).bytes.length).toBe((5 + boundary.length) * 2);
    chatError(() => chatMessagePayload(`${boundary}a`), 'textTooLarge');
    chatError(() => decodeChat([u8(12), new Uint8Array(MAX_CHAT_TEXT_BYTES + 1).fill(0x41)]), 'textTooLarge');
  });
});

// Extra coverage specific to the TypeScript port.
describe('chat protocol (port extras)', () => {
  test('the boundary text round-trips and tab/CR/LF are accepted', () => {
    const boundary = 'a'.repeat(MAX_CHAT_TEXT_BYTES / 2);
    expect(decodeChat([u8(12), utf16(boundary)])).toEqual({ type: 'message', text: boundary });
    expect(decodeChat([u8(12), utf16('\t\r\n')])).toEqual({ type: 'message', text: '\t\r\n' });
  });

  test('the UTF-8 budget applies even when UTF-16 units fit', () => {
    // 16384 BMP units of a 3-byte character: UTF-16 = 32768 bytes, UTF-8 = 49152.
    chatError(() => chatMessagePayload('日'.repeat(MAX_CHAT_TEXT_BYTES / 2)), 'textTooLarge');
    expect(chatMessagePayload('日'.repeat(10000)).bytes.length).toBe((5 + 10000) * 2);
  });

  test('a lone surrogate becomes U+FFFD like a Swift String would', () => {
    expect(chatMessagePayload('x\ud800y').bytes).toEqual(concat(utf16('12|||x'), u8(0xfd, 0xff), utf16('y')));
  });

  test('errors carry only the code, never the text', () => {
    let thrown: unknown;
    try {
      chatMessagePayload('secret|||text');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ChatError);
    expect((thrown as ChatError).message).toBe('unsupportedDelimiter');
  });
});
