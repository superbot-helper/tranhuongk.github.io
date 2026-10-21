// Pure control-path helpers of RelaySession (UltraViewerRelaySession.swift consumeApplication
// cases 0 (Peer fields), 3/4/28 (cursor) and 49 (input permission)). Kept out of
// relay-session.ts so the session file stays a readable port of the connection state machine.
import { decodeAudioMessage, type AudioMessage } from '../proto/audio-message';
import { decodeChat, type ChatEvent } from '../proto/chat';
import { decodeClipboard, type ClipboardZstd } from '../proto/clipboard';
import { parseMonitors, type RemoteMonitor } from '../proto/commands';
import { decodeCursorMessage, type CursorEvent, type CursorZstd } from '../proto/cursor';
import type { ModernScreenInitialization } from '../proto/screen-message';

/** Swift `version(_:atLeast:)`: exactly three non-negative integer fields, compared in order. */
export function versionAtLeast(text: string, required: [number, number, number]): boolean {
  const fields = text.split('.');
  if (fields.length !== 3 || !fields.every((f) => /^\+?[0-9]+$/.test(f))) return false;
  const values = fields.map(Number);
  for (let i = 0; i < 3; i++) {
    if (values[i]! !== required[i]) return values[i]! > required[i]!;
  }
  return true;
}

/** Binary keyboard packets (`[30]|||…`) are understood from Windows UltraViewer 6.2.13. */
export const BINARY_KEYBOARD_VERSION: [number, number, number] = [6, 2, 13];

/**
 * Init part 8 monitor records. Swift: `(try? RemoteControlCommands.monitors(...)) ?? []`;
 * `error` carries the parse failure so the session can log it once.
 */
export function initMonitors(init: ModernScreenInitialization): { monitors: RemoteMonitor[]; error: string | null } {
  try {
    return { monitors: parseMonitors(init.monitorInformationBytes ?? new Uint8Array()), error: null };
  } catch (e) {
    return { monitors: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Command 49 `[49][flag]`: true = view-only (flag != 0). Null when the flag byte is missing
 * (Swift throws malformedInitialization).
 */
export function viewOnlyFlag(parts: Uint8Array[]): boolean | null {
  const value = parts[1]?.[0];
  return value === undefined ? null : value !== 0;
}

const NO_ZSTD: CursorZstd = () => {
  throw new Error('cursor zstd not loaded');
};

/**
 * Commands 3/4/28. Swift `try? CursorMessage.decode(parts:)`: any malformed message is
 * dropped (null), as is the ignored command-3 hash. `zstd` is only awaited for command 4.
 */
export async function decodeCursor(parts: Uint8Array[], zstd: () => Promise<CursorZstd>): Promise<CursorEvent | null> {
  try {
    const decompress = parts[0]?.[0] === 4 ? await zstd() : NO_ZSTD;
    return decodeCursorMessage(parts, decompress);
  } catch {
    return null;
  }
}

/**
 * Swift `canUseSessionTools`: chat, typing, clipboard (and files) need an accepted peer and an
 * authenticated phase; a re-login or screen refresh (`login`) keeps them available.
 */
export function canUseTools(peerAccepted: boolean, phase: string): boolean {
  return peerAccepted && (phase === 'active' || phase === 'login');
}

/** Commands 12/29/30: `try? ChatProtocol.decodeViewerParts`; malformed chat is dropped (null). */
export function decodeChatMessage(parts: Uint8Array[]): ChatEvent | null {
  try {
    return decodeChat(parts);
  } catch {
    return null;
  }
}

/**
 * Commands 5/33: `try? ClipboardProtocol.decodeHostToViewer`. The zstd decoder is only awaited
 * for the modern command 33; any malformed message (or a decoder that cannot load) is dropped.
 */
export async function decodeClipboardMessage(
  parts: Uint8Array[], zstd: () => Promise<ClipboardZstd>,
): Promise<string | null> {
  try {
    const decompress = parts[0]?.[0] === 33 ? await zstd() : NO_CLIPBOARD_ZSTD;
    return decodeClipboard(parts, decompress);
  } catch {
    return null;
  }
}

const NO_CLIPBOARD_ZSTD: ClipboardZstd = () => {
  throw new Error('clipboard zstd not loaded');
};

/** Commands 42/43: `try? ComputerAudioMessage.decode`; malformed audio is dropped (null). */
export function decodeAudio(parts: Uint8Array[]): AudioMessage | null {
  try {
    return decodeAudioMessage(parts);
  } catch {
    return null;
  }
}

/** Anything with the G722Decoder surface; tests inject fakes. */
export interface PcmDecoder {
  decode(encoded: Uint8Array): Int16Array;
  dispose(): void;
}

/** 250 ms of 48 kHz stereo Int16 = 48,000 PCM bytes = 12,000 G.722 bytes (4 PCM bytes each). */
export const MAX_QUEUED_ENCODED_BYTES = 12_000;

/**
 * The session's G.722 decoder (Swift `audioDecoder`): created on the first packet, kept through
 * UI mute / host silence (the predictor must stay in step), disposed with the session.
 * Packets that arrive while the wasm module loads are queued in order, capped at the newest
 * 250 ms (older ones are dropped). A load failure is reported once and drops all audio.
 * `onPcm` receives every decoded packet; the owner decides whether to forward it.
 */
export class SessionAudioDecoder {
  private decoder: PcmDecoder | null = null;
  private loading = false;
  private failed = false;
  private disposed = false;
  private decodeErrorReported = false;
  private queue: Uint8Array[] = [];
  private queued = 0;

  constructor(
    private readonly create: () => Promise<PcmDecoder>,
    private readonly onPcm: (pcm: Int16Array) => void,
    private readonly onError: (kind: 'load' | 'decode', error: unknown) => void,
  ) {}

  push(encoded: Uint8Array): void {
    if (this.disposed || this.failed) return;
    if (this.decoder !== null) {
      this.decodeOne(this.decoder, encoded);
      return;
    }
    this.queue.push(encoded);
    this.queued += encoded.length;
    while (this.queued > MAX_QUEUED_ENCODED_BYTES && this.queue.length > 0) this.queued -= this.queue.shift()!.length;
    if (this.loading) return;
    this.loading = true;
    let creating: Promise<PcmDecoder>;
    try {
      creating = this.create();
    } catch (e) {
      creating = Promise.reject(e);
    }
    creating.then(
      (decoder) => {
        if (this.disposed) {
          decoder.dispose();
          return;
        }
        this.decoder = decoder;
        const pending = this.queue;
        this.queue = [];
        this.queued = 0;
        for (const packet of pending) this.decodeOne(decoder, packet);
      },
      (e: unknown) => {
        if (this.disposed) return;
        this.failed = true;
        this.queue = [];
        this.queued = 0;
        this.onError('load', e);
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.queued = 0;
    this.decoder?.dispose();
    this.decoder = null;
  }

  private decodeOne(decoder: PcmDecoder, encoded: Uint8Array): void {
    let pcm: Int16Array;
    try {
      pcm = decoder.decode(encoded);
    } catch (e) {
      if (!this.decodeErrorReported) {
        this.decodeErrorReported = true;
        this.onError('decode', e);
      }
      return;
    }
    if (pcm.length > 0) this.onPcm(pcm);
  }
}
