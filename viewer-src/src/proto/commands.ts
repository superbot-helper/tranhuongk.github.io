// Port of UltraViewerProtocol/RemoteControlCommands.swift (without the side-switch
// request, which is out of scope for the browser viewer).
// Verified viewer-to-host application commands. The session owns approval, control
// permission and routing; these pure builders never execute an action.

export interface RemoteMessage {
  bytes: Uint8Array;
  /** True when `bytes` are UTF-16LE (Unicode SendString), false for ASCII. */
  formatFlag: boolean;
}

export type RemoteAction = 'ctrlAltDel' | 'restart' | 'lock';
export type QualityPreset = 'auto' | 'speed' | 'quality';

export type RemoteCommand =
  | { type: 'action'; action: RemoteAction }
  | { type: 'quality'; preset: QualityPreset }
  | { type: 'wallpaper'; visible: boolean }
  | { type: 'cursorPositions'; enabled: boolean }
  | { type: 'computerSound'; enabled: boolean }
  | { type: 'endSession' };

export type RemoteControlCommandsErrorCode = 'malformedMonitorInformation' | 'tooManyMonitors' | 'invalidMonitorGeometry';

export class RemoteControlCommandsError extends Error {
  readonly code: RemoteControlCommandsErrorCode;
  constructor(code: RemoteControlCommandsErrorCode) {
    super(code);
    this.name = 'RemoteControlCommandsError';
    this.code = code;
  }
}

const ACTION_TAG: Record<RemoteAction, string> = { ctrlAltDel: '22', restart: '40', lock: '53' };
/** Swift QualityPreset.displayQuality. */
const PRESET_QUALITY: Record<QualityPreset, number> = { auto: 45, speed: 30, quality: 70 };

function ascii(text: string): RemoteMessage {
  return { bytes: new TextEncoder().encode(text), formatFlag: false };
}

function unicode(text: string): RemoteMessage {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    bytes[i * 2] = unit & 0xff;
    bytes[i * 2 + 1] = unit >> 8;
  }
  return { bytes, formatFlag: true };
}

/** ChangeDisplayQuality: ASCII signed Long. UI limits belong to the caller. */
export function qualityMessage(value: number): RemoteMessage {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError('quality must be a signed 32-bit integer');
  }
  return ascii(`31|||${value}`);
}

/** The supported RGB555 converter mode (source value 2). */
const rgb555ColorMode = (): RemoteMessage => ascii('32|||2');

/** The ordered messages to send for one command; presets are two messages. */
export function commandPayload(c: RemoteCommand): RemoteMessage[] {
  switch (c.type) {
    case 'action':
      return [unicode(ACTION_TAG[c.action])];
    case 'quality':
      return [rgb555ColorMode(), qualityMessage(PRESET_QUALITY[c.preset])];
    case 'wallpaper':
      return [unicode(`23|||${c.visible ? -1 : 0}`)];
    case 'cursorPositions':
      return [ascii(`28|||${c.enabled ? 1 : 0}`)];
    case 'computerSound':
      return [unicode(`46|||${c.enabled ? -1 : 0}`)];
    case 'endSession':
      return [ascii('19')];
  }
}

export interface RemoteMonitor {
  /** One-based native menu index; zero is the native all-monitors selection. */
  index: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

/** Swift `Int32(field)` for the restricted `[-0-9]` alphabet. */
function parseInt32(field: string): number | undefined {
  if (!/^-?[0-9]+$/.test(field)) return undefined;
  const value = Number(field);
  return value >= INT32_MIN && value <= INT32_MAX ? (value === 0 ? 0 : value) : undefined;
}

/**
 * Command 0 part 8: each monitor is `left:top:right:bottom` followed by `|`.
 * Monitor selection crops the virtual desktop locally; it sends no command.
 */
export function parseMonitors(bytes: Uint8Array, maximumMonitors = 64): RemoteMonitor[] {
  if (bytes.length > 16_384 || maximumMonitors <= 0) throw new RemoteControlCommandsError('malformedMonitorInformation');
  for (const b of bytes) {
    // '-' ':' '|' and digits only.
    if (!(b === 45 || b === 58 || b === 124 || (b >= 48 && b <= 57))) {
      throw new RemoteControlCommandsError('malformedMonitorInformation');
    }
  }
  if (bytes.length === 0) return [];
  const text = new TextDecoder().decode(bytes);
  if (!text.endsWith('|')) throw new RemoteControlCommandsError('malformedMonitorInformation');
  const records = text.slice(0, -1).split('|');
  if (records.length > maximumMonitors) throw new RemoteControlCommandsError('tooManyMonitors');
  return records.map((record, i) => {
    const fields = record.split(':');
    if (fields.length !== 4) throw new RemoteControlCommandsError('malformedMonitorInformation');
    const numbers = fields.map((f) => {
      const value = parseInt32(f);
      if (value === undefined) throw new RemoteControlCommandsError('malformedMonitorInformation');
      return value;
    }) as [number, number, number, number];
    const [left, top, right, bottom] = numbers;
    if (right <= left || bottom <= top || right - left > INT32_MAX || bottom - top > INT32_MAX) {
      throw new RemoteControlCommandsError('invalidMonitorGeometry');
    }
    return { index: i + 1, left, top, right, bottom };
  });
}

/** Windows virtual-desktop coordinates → bounded decoded-pixel region; throws when outside the canvas. */
export function monitorRegion(
  m: RemoteMonitor,
  virtualLeft: number,
  virtualTop: number,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const x = m.left - virtualLeft;
  const y = m.top - virtualTop;
  const w = m.right - m.left;
  const h = m.bottom - m.top;
  if (!(width > 0 && height > 0 && x >= 0 && y >= 0 && x + w <= width && y + h <= height)) {
    throw new RemoteControlCommandsError('invalidMonitorGeometry');
  }
  return { x, y, w, h };
}
