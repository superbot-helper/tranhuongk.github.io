// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { packedPosition } from '../proto/mouse';
import { peer, TestSession } from './test-session';
import { RecorderError, UNSUPPORTED_REASON, type RecorderLike, type RecorderOptions, type RecorderSupport, type Recording } from './recorder';
import { mountViewer, type ScreenRecording, type ViewerHandle } from './viewer';

vi.mock('../net/trust', () => ({ checkServerChain: vi.fn(), defaultAnchors: () => [] }));

/** A recorder that records its calls; `stop()` resolves with `result`. */
class FakeRecorder implements RecorderLike {
  frames = 0;
  stops = 0;
  aborts = 0;
  result: Recording | null = {
    blob: new Blob(['x'.repeat(2048)], { type: 'video/webm' }),
    mime: 'video/webm',
    ext: 'webm',
    seconds: 75,
    startedAt: new Date(2026, 9, 21, 8, 30, 15),
  };
  constructor(readonly options: Pick<RecorderOptions, 'source' | 'onTick' | 'onError'>) {}
  frame(): void {
    this.frames++;
  }
  stop(): Promise<Recording | null> {
    this.stops++;
    return Promise.resolve(this.result);
  }
  abort(): void {
    this.aborts++;
  }
}

/** Microtasks only: the timers of this file are fake. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('screenshots, annotation and recording in the viewer page', () => {
  let session: TestSession;
  let app: HTMLElement;
  let viewer: ViewerHandle;
  let canvas: HTMLCanvasElement;
  let recorders: FakeRecorder[];
  let support: RecorderSupport;
  let startError: Error | null;
  let downloads: Array<{ name: string; type: string }>;
  let drawImageSources: unknown[];
  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
  const item = (sel: string) => $<HTMLButtonElement>(sel);
  const menuItem = (text: string) => [...app.querySelectorAll<HTMLButtonElement>('#capture-menu button')].find((b) => b.textContent === text)!;

  function mount(): void {
    document.body.innerHTML = '<main id="app"></main>';
    app = document.getElementById('app')!;
    const recording: ScreenRecording = {
      support: () => support,
      start: (o) => {
        if (startError) throw startError;
        const r = new FakeRecorder(o);
        recorders.push(r);
        return r;
      },
    };
    viewer = mountViewer(app, { createSession: () => session, workerUrl: 'ws://127.0.0.1:8787', schedule: (cb) => cb(), recording });
    canvas = $<HTMLCanvasElement>('#screen');
    canvas.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 960, height: 540 });
  }

  function connect(): void {
    $<HTMLInputElement>('#token').value = 'x'.repeat(32);
    $<HTMLInputElement>('#partner').value = '123456789';
    $<HTMLInputElement>('#password').value = 'abc';
    $<HTMLFormElement>('#connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
    session.emit({ type: 'accepted', peer: peer({ displayName: 'Máy/kế:toán', width: 8, height: 4 }) });
  }

  const frame = () => session.emit({ type: 'frame', bitmap: { width: 8, height: 4, rgba: new Uint8ClampedArray(8 * 4 * 4) } });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(2026, 9, 21, 9, 5, 7));
    recorders = [];
    support = { ok: true, mime: 'video/webm', ext: 'webm' };
    startError = null;
    downloads = [];
    drawImageSources = [];
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    // A drawing context that remembers the sources of drawImage (the annotator preview).
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() =>
      new Proxy({} as Record<string, unknown>, {
        get: (t, p: string) => (p in t ? t[p] : (...args: unknown[]) => void (p === 'drawImage' && drawImageSources.push(args[0]))),
        set: (t, p: string, v) => ((t[p] = v), true),
      })) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => `blob:${b.type}`;
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, type: this.href });
    });
    session = new TestSession();
    mount();
  });

  afterEach(() => {
    viewer.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('the Chụp menu has the four entries and they wait for the first decoded frame', () => {
    const labels = [...app.querySelectorAll('#capture-menu button')].map((b) => b.textContent);
    expect(labels).toEqual(['Chụp và chú thích…', 'Chụp một vùng…', 'Lưu toàn màn hình (PNG)', 'Quay màn hình']);
    expect(app.querySelector('#capture-menu summary')!.textContent).toBe('Chụp');
    connect();
    expect(menuItem('Lưu toàn màn hình (PNG)').disabled).toBe(true);
    expect(menuItem('Quay màn hình').disabled).toBe(true);
    frame();
    expect(menuItem('Chụp và chú thích…').disabled).toBe(false);
    expect(menuItem('Lưu toàn màn hình (PNG)').disabled).toBe(false);
    expect(menuItem('Quay màn hình').disabled).toBe(false);
  });

  test('Lưu toàn màn hình downloads a PNG named <máy> yyyy-MM-dd HH.mm.ss.png, synchronously inside the click', () => {
    connect();
    frame();
    menuItem('Lưu toàn màn hình (PNG)').click();
    expect(downloads).toEqual([{ name: 'Máy-kế-toán 2026-10-21 09.05.07.png', type: 'data:image/png;base64,AAAA' }]);
    expect(document.querySelector('.cap-modal')).toBeNull();
  });

  test('Chụp và chú thích opens the modal on a snapshot, not the live canvas; Lưu PNG downloads; Đóng closes', () => {
    connect();
    frame();
    menuItem('Chụp và chú thích…').click();
    const modal = document.querySelector('.cap-modal');
    expect(modal).not.toBeNull();
    expect(modal!.querySelector('[data-tool="pen"]')!.getAttribute('aria-pressed')).toBe('true');
    // The first draw copies the live canvas into the snapshot; the preview then draws only the snapshot.
    expect(drawImageSources[0]).toBe(canvas);
    const preview = drawImageSources.slice(1);
    expect(preview.length).toBeGreaterThan(0);
    expect(preview.every((s) => s instanceof HTMLCanvasElement && s !== canvas)).toBe(true);
    modal!.querySelector<HTMLButtonElement>('.cap-save')!.click();
    expect(downloads).toEqual([{ name: 'Máy-kế-toán 2026-10-21 09.05.07.png', type: 'data:image/png;base64,AAAA' }]);
    modal!.querySelector<HTMLButtonElement>('.cap-close')!.click();
    expect(document.querySelector('.cap-modal')).toBeNull();
  });

  test('with the stage fullscreen the annotator opens inside it, so it is visible', () => {
    connect();
    frame();
    const stage = $<HTMLElement>('#stage');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => stage });
    menuItem('Chụp và chú thích…').click();
    expect(document.querySelector('.cap-modal')!.parentElement).toBe(stage);
    document.querySelector<HTMLButtonElement>('.cap-close')!.click();
    delete (document as unknown as Record<string, unknown>).fullscreenElement;
  });

  test('Chụp một vùng opens on the region tool with nothing selected', () => {
    connect();
    frame();
    menuItem('Chụp một vùng…').click();
    const modal = document.querySelector('.cap-modal')!;
    expect(modal.querySelector('[data-tool="region"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(modal.querySelector<HTMLButtonElement>('.cap-save')!.disabled).toBe(true);
  });

  test('while the modal is open nothing goes to Windows; held input is released first; control comes back on close', async () => {
    connect();
    frame();
    const pointer = (type: string) =>
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 480, clientY: 270, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
    pointer('pointerdown'); // left button held on Windows
    await settle();
    const before = session.sent.length;
    menuItem('Chụp và chú thích…').click();
    await settle();
    expect(session.sent.slice(before)).toEqual([`8|||514|||0|||${packedPosition(4, 2)}`]); // released
    const released = session.sent.length;
    pointer('pointerdown');
    pointer('pointerup');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));
    await settle();
    expect(session.sent.length).toBe(released);
    document.querySelector<HTMLButtonElement>('.cap-close')!.click();
    pointer('pointerdown');
    await settle();
    expect(session.sent.length).toBeGreaterThan(released);
  });

  test('Quay màn hình starts the recorder on the screen canvas, shows Dừng quay (m:ss), and feeds it new frames', () => {
    connect();
    frame();
    menuItem('Quay màn hình').click();
    expect(recorders).toHaveLength(1);
    expect(recorders[0]!.options.source).toBe(canvas);
    expect(menuItem('Dừng quay (0:00)')).toBeDefined();
    expect(app.querySelector('#capture-menu summary')!.textContent).toBe('Chụp ● 0:00');
    recorders[0]!.options.onTick(65);
    expect(menuItem('Dừng quay (1:05)')).toBeDefined();
    const before = recorders[0]!.frames;
    frame();
    frame();
    expect(recorders[0]!.frames).toBe(before + 2);
  });

  test('a frame that arrives while the tab is hidden is painted at once for the recording', () => {
    connect();
    frame();
    menuItem('Quay màn hình').click();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const before = recorders[0]!.frames;
    session.emit({ type: 'frame', bitmap: { width: 8, height: 4, rgba: new Uint8ClampedArray(8 * 4 * 4) } });
    // Once from the scheduler stub (which here runs at once) and once from the direct paint.
    expect(recorders[0]!.frames).toBeGreaterThan(before + 1);
    spy.mockRestore();
  });

  test('Dừng quay stops the recorder and offers "Tải video về", which downloads <máy> <start>.webm', async () => {
    connect();
    frame();
    menuItem('Quay màn hình').click();
    menuItem('Dừng quay (0:00)').click();
    expect(recorders[0]!.stops).toBe(1);
    expect(menuItem('Quay màn hình')).toBeDefined();
    await settle();
    const toast = $<HTMLElement>('#capture-toast');
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain('Đã quay xong (1:15, 2 KB)');
    expect(downloads).toHaveLength(0); // never without a click
    toast.querySelector<HTMLButtonElement>('.toast-action')!.click();
    expect(downloads).toEqual([{ name: 'Máy-kế-toán 2026-10-21 08.30.15.webm', type: 'blob:video/webm' }]);
    expect(toast.hidden).toBe(true);
  });

  test('disconnecting while recording stops the recorder and offers the video', async () => {
    connect();
    frame();
    menuItem('Quay màn hình').click();
    session.emit({ type: 'closed', reason: null });
    expect(recorders[0]!.stops).toBe(1);
    await settle();
    const toast = $<HTMLElement>('#capture-toast');
    expect(toast.hidden).toBe(false);
    expect(toast.querySelector<HTMLButtonElement>('.toast-action')!.textContent).toBe('Tải video về');
    expect(menuItem('Quay màn hình')).toBeDefined();
    toast.querySelector<HTMLButtonElement>('.toast-action')!.click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.name.endsWith('.webm')).toBe(true);
  });

  test('a recording with no data says so and offers nothing', async () => {
    connect();
    frame();
    menuItem('Quay màn hình').click();
    recorders[0]!.result = null;
    menuItem('Dừng quay (0:00)').click();
    await settle();
    expect($<HTMLElement>('#capture-toast').textContent).toContain('Không có dữ liệu video');
    expect($<HTMLButtonElement>('#capture-toast .toast-action').hidden).toBe(true);
  });

  test('an encoder error stops the recording and still offers what was recorded', async () => {
    connect();
    frame();
    menuItem('Quay màn hình').click();
    recorders[0]!.options.onError?.();
    expect(recorders[0]!.stops).toBe(1);
    await settle();
    expect($<HTMLButtonElement>('#capture-toast .toast-action').hidden).toBe(false);
  });

  test('a browser without MediaRecorder disables Quay màn hình with the reason', () => {
    support = { ok: false, reason: UNSUPPORTED_REASON };
    connect();
    frame();
    const record = menuItem('Quay màn hình');
    expect(record.disabled).toBe(true);
    expect(record.title).toBe(UNSUPPORTED_REASON);
    expect(menuItem('Lưu toàn màn hình (PNG)').disabled).toBe(false);
  });

  test('a recorder that cannot start shows a notice', () => {
    startError = new RecorderError('failed');
    connect();
    frame();
    menuItem('Quay màn hình').click();
    expect(recorders).toHaveLength(0);
    expect($<HTMLElement>('#capture-toast').textContent).toContain('Không bắt đầu được quay video');
    expect(menuItem('Quay màn hình')).toBeDefined();
  });

  test('destroying the page mid-recording throws the recording away', () => {
    connect();
    frame();
    menuItem('Quay màn hình').click();
    viewer.destroy();
    expect(recorders[0]!.aborts).toBe(1);
    expect(recorders[0]!.stops).toBe(0);
    mount(); // for afterEach
  });

  test('the menu is unavailable again after the session closes', () => {
    connect();
    frame();
    session.emit({ type: 'closed', reason: null });
    expect(menuItem('Lưu toàn màn hình (PNG)').disabled).toBe(true);
    expect(item('#record-toggle').disabled).toBe(true);
  });
});
