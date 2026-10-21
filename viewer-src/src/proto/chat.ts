// Port of UltraViewerProtocol/ChatProtocol.swift (the viewer side only).
// Chat application messages for an authenticated peer route. This module does
// not perform routing, session authorization, UI display, or transcript logging.
import type { RemoteMessage } from './commands';
import { decodeUtf16leStrict, toWellFormed, utf16le, utf8Length } from './utf16';

export type ChatErrorCode = 'textTooLarge' | 'invalidEncoding' | 'invalidText' | 'unsupportedDelimiter' | 'malformedMessage';

/** The message carries only the code: never the chat text. */
export class ChatError extends Error {
  readonly code: ChatErrorCode;
  constructor(code: ChatErrorCode) {
    super(code);
    this.name = 'ChatError';
    this.code = code;
  }
}

/** Local resource budget in bytes, checked for both UTF-8 and UTF-16LE. */
export const MAX_CHAT_TEXT_BYTES = 32 * 1024;

export type ChatEvent = { type: 'message'; text: string } | { type: 'typing'; typing: boolean };

/** Local text policy: within budget, no control characters except tab, LF and CR. */
function validate(text: string): void {
  if (text.length > MAX_CHAT_TEXT_BYTES / 2 || utf8Length(text) > MAX_CHAT_TEXT_BYTES) throw new ChatError('textTooLarge');
  // BSTR terminators and other control characters are rejected as local policy.
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 32 && unit !== 9 && unit !== 10 && unit !== 13) throw new ChatError('invalidText');
  }
}

/** Form1.SendString: UTF-16LE "12|||<text>", relay format flag true. */
export function chatMessagePayload(text: string): RemoteMessage & { formatFlag: true } {
  const wellFormed = toWellFormed(text);
  validate(wellFormed);
  // The Windows host uses an unlimited delimiter split and reads index 1.
  if (wellFormed.includes('|||')) throw new ChatError('unsupportedDelimiter');
  return { bytes: utf16le(`12|||${wellFormed}`), formatFlag: true };
}

/** The Windows viewer sends these through the same Unicode SendString path. */
export function chatTypingPayload(typing: boolean): RemoteMessage & { formatFlag: true } {
  return { bytes: utf16le(typing ? '29' : '30'), formatFlag: true };
}

/**
 * Decode the host-to-viewer multipart form after bounded multipart parsing.
 * Unrelated commands return null; malformed chat throws ChatError.
 */
export function decodeChat(parts: Uint8Array[]): ChatEvent | null {
  const head = parts[0];
  const command = head?.[0];
  if (head === undefined || command === undefined || (command !== 12 && command !== 29 && command !== 30)) return null;
  // Windows 6.6.133 emits Int16LE commands. Retain the one-byte form used by
  // earlier MacViewer builds, but reject truncated/ambiguous headers.
  if (!(head.length === 1 || (head.length === 2 && head[1] === 0))) throw new ChatError('malformedMessage');
  if (command !== 12) {
    if (parts.length !== 1) throw new ChatError('malformedMessage');
    return { type: 'typing', typing: command === 29 };
  }
  if (parts.length !== 2) throw new ChatError('malformedMessage');
  const bytes = parts[1]!;
  if (bytes.length > MAX_CHAT_TEXT_BYTES) throw new ChatError('textTooLarge');
  const text = decodeUtf16leStrict(bytes);
  if (text === null) throw new ChatError('invalidEncoding');
  validate(text);
  return { type: 'message', text };
}
