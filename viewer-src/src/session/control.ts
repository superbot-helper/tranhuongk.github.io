// Pure control-path helpers of RelaySession (UltraViewerRelaySession.swift consumeApplication
// cases 0 (Peer fields), 3/4/28 (cursor) and 49 (input permission)). Kept out of
// relay-session.ts so the session file stays a readable port of the connection state machine.
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
