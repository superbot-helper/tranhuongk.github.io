import { describe, expect, test } from 'vitest';
import {
  RemoteControlCommandsError,
  type RemoteMonitor,
  commandPayload,
  monitorRegion,
  parseMonitors,
  qualityMessage,
} from './commands';
import { enc, u8 } from './test-utils';

function commandsError(fn: () => unknown): RemoteControlCommandsError {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(RemoteControlCommandsError);
  return thrown as RemoteControlCommandsError;
}

function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out[i * 2] = unit & 0xff;
    out[i * 2 + 1] = unit >> 8;
  }
  return out;
}

// Ported from RemoteControlCommandsTests.swift. The side-switch (54|||) test is
// intentionally not ported: it is out of scope for the browser viewer.
describe('remote control commands (RemoteControlCommandsTests.swift)', () => {
  test('remoteActionFixturesOnlyEncodeRequestsAndNeverPerformActions', () => {
    const fixtures: [Parameters<typeof commandPayload>[0], number[]][] = [
      [{ type: 'action', action: 'ctrlAltDel' }, [0x32, 0, 0x32, 0]],
      [{ type: 'action', action: 'restart' }, [0x34, 0, 0x30, 0]],
      [{ type: 'action', action: 'lock' }, [0x35, 0, 0x33, 0]],
    ];
    for (const [command, expected] of fixtures) {
      const messages = commandPayload(command);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.formatFlag).toBe(true);
      expect(messages[0]!.bytes).toEqual(u8(...expected));
    }
  });

  test('remoteDisplaySettingsPreserveDirectionAndBooleanRepresentation', () => {
    expect(qualityMessage(70)).toEqual({ bytes: enc('31|||70'), formatFlag: false });
    expect(qualityMessage(-2147483648).bytes).toEqual(enc('31|||-2147483648'));
    expect(() => qualityMessage(2147483648)).toThrow(RangeError);
    expect(() => qualityMessage(1.5)).toThrow(RangeError);

    const [wallpaperShown] = commandPayload({ type: 'wallpaper', visible: true });
    expect(wallpaperShown!.bytes).toEqual(u8(0x32, 0, 0x33, 0, 0x7c, 0, 0x7c, 0, 0x7c, 0, 0x2d, 0, 0x31, 0));
    expect(wallpaperShown!.formatFlag).toBe(true);
    const [wallpaperHidden] = commandPayload({ type: 'wallpaper', visible: false });
    expect(wallpaperHidden!.bytes).toEqual(u8(0x32, 0, 0x33, 0, 0x7c, 0, 0x7c, 0, 0x7c, 0, 0x30, 0));
    expect(wallpaperHidden!.formatFlag).toBe(true);

    for (const enabled of [false, true]) {
      const cursor = commandPayload({ type: 'cursorPositions', enabled });
      expect(cursor).toEqual([{ bytes: enc(enabled ? '28|||1' : '28|||0'), formatFlag: false }]);
      const sound = commandPayload({ type: 'computerSound', enabled });
      expect(sound).toEqual([{ bytes: utf16le(enabled ? '46|||-1' : '46|||0'), formatFlag: true }]);
    }

    const presets = [
      ['auto', 45],
      ['speed', 30],
      ['quality', 70],
    ] as const;
    for (const [preset, quality] of presets) {
      const messages = commandPayload({ type: 'quality', preset });
      // rgb555ColorMode first, then the display quality.
      expect(messages.map((m) => m.bytes)).toEqual([enc('32|||2'), enc(`31|||${quality}`)]);
      expect(messages.every((m) => !m.formatFlag)).toBe(true);
    }
  });

  test('viewerEndSessionMatchesTheWindowsViewerGoodbye', () => {
    // The Windows viewer's last peer message is command19; the host session
    // parser reads the tag before any field separator.
    expect(commandPayload({ type: 'endSession' })).toEqual([{ bytes: enc('19'), formatFlag: false }]);
  });

  test('remoteMonitorsDecodeNativeTrailingSeparatorAndNegativeOrigins', () => {
    const monitors = parseMonitors(enc('-1920:0:0:1080|0:-200:2560:1240|'));
    expect(monitors).toHaveLength(2);
    const [first, second] = monitors as [RemoteMonitor, RemoteMonitor];
    expect(first).toEqual({ index: 1, left: -1920, top: 0, right: 0, bottom: 1080 });
    expect(first.right - first.left).toBe(1920);
    expect(second).toEqual({ index: 2, left: 0, top: -200, right: 2560, bottom: 1240 });
    expect(second.bottom - second.top).toBe(1440);
    expect(monitorRegion(first, -1920, -200, 4480, 1440)).toEqual({ x: 0, y: 200, w: 1920, h: 1080 });
    expect(parseMonitors(new Uint8Array())).toEqual([]);
    expect(commandsError(() => monitorRegion(first, 0, 0, 4480, 1440)).code).toBe('invalidMonitorGeometry');
  });

  test('remoteMonitorsRejectMalformedRecordsAndOutOfBoundsGeometry', () => {
    for (const text of ['Mac|', '0:0:1920:1080', '0:0:1920|', '0:0:1920:1080||', '0:0:1:1:2|', '0:0:2147483648:1|', '0:0:1:1|\0', '0: 0:1:1|']) {
      expect(commandsError(() => parseMonitors(enc(text))).code, text).toBe('malformedMonitorInformation');
    }
    for (const text of ['1:0:1:1|', '0:1:1:0|', '-2147483648:0:2147483647:1|']) {
      expect(commandsError(() => parseMonitors(enc(text))).code, text).toBe('invalidMonitorGeometry');
    }
    expect(commandsError(() => parseMonitors(enc('0:0:1:1|1:0:2:1|'), 1)).code).toBe('tooManyMonitors');
  });

  // TypeScript-only additions around Swift's size/bounds guards.
  test('monitor parsing bounds and region guards', () => {
    expect(commandsError(() => parseMonitors(new Uint8Array(16_385).fill(0x31))).code).toBe('malformedMonitorInformation');
    expect(commandsError(() => parseMonitors(enc('|'))).code).toBe('malformedMonitorInformation');
    expect(commandsError(() => parseMonitors(enc('-:0:1:1|'))).code).toBe('malformedMonitorInformation');
    expect(parseMonitors(enc('-0:0:1:1|'))).toEqual([{ index: 1, left: 0, top: 0, right: 1, bottom: 1 }]);
    const monitor: RemoteMonitor = { index: 1, left: 0, top: 0, right: 100, bottom: 50 };
    expect(commandsError(() => monitorRegion(monitor, 0, 0, 0, 50)).code).toBe('invalidMonitorGeometry');
    expect(commandsError(() => monitorRegion(monitor, 0, 0, 99, 50)).code).toBe('invalidMonitorGeometry');
    expect(commandsError(() => monitorRegion(monitor, 0, 0, 100, 49)).code).toBe('invalidMonitorGeometry');
    expect(commandsError(() => monitorRegion(monitor, 1, 0, 100, 50)).code).toBe('invalidMonitorGeometry');
    expect(monitorRegion(monitor, 0, 0, 100, 50)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });
});
