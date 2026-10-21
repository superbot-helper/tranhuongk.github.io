// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RemoteMonitor } from '../proto/commands';
import { packedPosition } from '../proto/mouse';
import type { Peer } from '../session/relay-session';
import { curFile, dib } from './cur-test-utils';
import { packet, peer, settle, TestSession } from './test-session';
import { mountViewer, type ViewerHandle } from './viewer';

// The jsdom (web) transform refuses the bundled *.pem?raw trust anchors (Vite fs.deny); the
// page under test never opens TLS, so the trust module is stubbed.
vi.mock('../net/trust', () => ({ checkServerChain: vi.fn(), defaultAnchors: () => [] }));

const key = (code: string, key: string, over: Partial<KeyInit> = {}): KeyInit => ({ code, key, ...over });
type KeyInit = KeyboardEventInit & { code: string; key: string };

describe('desktop viewer page', () => {
  let session: TestSession;
  let app: HTMLElement;
  let viewer: ViewerHandle;
  let canvas: HTMLCanvasElement;
  let textarea: HTMLTextAreaElement;

  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

  function connect(p: Peer = peer()): void {
    $<HTMLInputElement>('#partner').value = '123 456 789';
    $<HTMLInputElement>('#password').value = 'abc';
    $<HTMLFormElement>('#connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(session.options?.partnerID).toBe('123456789');
    session.emit({ type: 'accepted', peer: p });
  }

  function pointer(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
    const e = new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, ...init,
    });
    canvas.dispatchEvent(e);
    return e;
  }

  function keyEvent(type: 'keydown' | 'keyup', init: KeyInit): KeyboardEvent {
    const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    textarea.dispatchEvent(e);
    return e;
  }

  const sentSince = (n: number) => session.sent.slice(n);

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = '<main id="app"></main>';
    app = document.getElementById('app')!;
    session = new TestSession();
    viewer = mountViewer(app, { createSession: () => session, workerUrl: 'ws://127.0.0.1:8787', schedule: (cb) => cb() });
    canvas = $<HTMLCanvasElement>('#screen');
    textarea = $<HTMLTextAreaElement>('#keyboard-input');
    // A 960x540 content box at the page origin.
    canvas.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 960, height: 540 });
  });

  afterEach(() => {
    viewer.destroy();
    vi.restoreAllMocks();
  });

  test('left button at the centre of a 960x540 canvas showing 1920x1080 sends a move then a press', async () => {
    connect();
    const e = pointer('pointerdown', 480, 270);
    await settle();
    expect(e.defaultPrevented).toBe(true);
    // Swift-faithful flags: the move before a press carries the flags held before it (0).
    expect(session.sent).toEqual(['8|||512|||0|||960|||540', `8|||513|||1|||${packedPosition(960, 540)}`]);
    expect(document.activeElement).toBe(textarea);
    pointer('pointerup', 480, 270, { buttons: 0 });
    await settle();
    // Swift quirk kept by the encoder: the release re-sends a move because the flags changed.
    expect(sentSince(2)).toEqual(['8|||512|||1|||960|||540', `8|||514|||0|||${packedPosition(960, 540)}`]);
  });

  test('keydown KeyA sends keyboard kind 1 VK 0x41 and blocks the browser default', async () => {
    connect();
    const down = keyEvent('keydown', key('KeyA', 'a'));
    const up = keyEvent('keyup', key('KeyA', 'a'));
    await settle();
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(session.sent).toEqual([packet(1, 0x41, 0x1e, 0x61), packet(2, 0x41, 0x1e, 0x61)]);
  });

  test('window blur while holding a key and a button releases both', async () => {
    connect();
    keyEvent('keydown', key('KeyA', 'a'));
    pointer('pointerdown', 480, 270);
    await settle();
    const n = session.sent.length;
    window.dispatchEvent(new Event('blur'));
    await settle();
    expect(sentSince(n)).toEqual([packet(2, 0x41, 0x1e, 0x61), `8|||514|||0|||${packedPosition(960, 540)}`]);
    // Nothing left to release.
    window.dispatchEvent(new Event('blur'));
    await settle();
    expect(session.sent.length).toBe(n + 2);
  });

  test('visibilitychange to hidden and pagehide release held input', async () => {
    connect();
    keyEvent('keydown', key('KeyB', 'b'));
    await settle();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(session.sent.at(-1)).toEqual(packet(2, 0x42, 0x30, 0x62));
    keyEvent('keydown', key('KeyB', 'b'));
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(session.sent.at(-1)).toEqual(packet(2, 0x42, 0x30, 0x62));
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  test('turning Điều khiển off releases held input and stops sending', async () => {
    connect();
    keyEvent('keydown', key('KeyA', 'a'));
    await settle();
    const toggle = $<HTMLButtonElement>('#control-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    await settle();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(session.sent.at(-1)).toEqual(packet(2, 0x41, 0x1e, 0x61));
    const n = session.sent.length;
    const down = keyEvent('keydown', key('KeyA', 'a'));
    const p = pointer('pointerdown', 480, 270);
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, clientX: 10, clientY: 10 }));
    await settle();
    expect(session.sent.length).toBe(n);
    expect(down.defaultPrevented).toBe(false);
    expect(p.defaultPrevented).toBe(false);
    // Back on: input flows again.
    toggle.click();
    keyEvent('keydown', key('KeyA', 'a'));
    await settle();
    expect(session.sent.at(-1)).toEqual(packet(1, 0x41, 0x1e, 0x61));
  });

  test('command 49 false releases held input and locks control until permission returns', async () => {
    connect();
    pointer('pointerdown', 480, 270);
    await settle();
    const n = session.sent.length;
    session.emit({ type: 'inputPermission', allowed: false });
    await settle();
    expect(sentSince(n)).toEqual([`8|||514|||0|||${packedPosition(960, 540)}`]);
    const toggle = $<HTMLButtonElement>('#control-toggle');
    expect(toggle.disabled).toBe(true);
    expect($('#notice').textContent).toContain('chỉ xem');
    keyEvent('keydown', key('KeyA', 'a'));
    pointer('pointerdown', 10, 10);
    await settle();
    expect(session.sent.length).toBe(n + 1);
    session.emit({ type: 'inputPermission', allowed: true });
    expect(toggle.disabled).toBe(false);
    keyEvent('keydown', key('KeyA', 'a'));
    await settle();
    expect(session.sent.at(-1)).toEqual(packet(1, 0x41, 0x1e, 0x61));
  });

  test('a refresh re-init restores control from peer.allowsRemoteInput', async () => {
    connect();
    session.emit({ type: 'inputPermission', allowed: false });
    session.emit({ type: 'accepted', peer: peer() });
    keyEvent('keydown', key('KeyA', 'a'));
    await settle();
    expect(session.sent.at(-1)).toEqual(packet(1, 0x41, 0x1e, 0x61));
  });

  test('choosing monitor 2 releases first and shifts coordinates by the crop and the virtual origin', async () => {
    const monitors: RemoteMonitor[] = [
      { index: 1, left: -1920, top: 0, right: 0, bottom: 1080 },
      { index: 2, left: 0, top: 0, right: 1920, bottom: 1080 },
    ];
    connect(peer({ width: 3840, height: 1080, virtualLeft: -1920, monitors }));
    const select = $<HTMLSelectElement>('#monitor');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Tất cả', 'Màn hình 1', 'Màn hình 2']);
    // All monitors: 3840x1080 contain-fitted into 960x540 (scale 0.25, 135 px bars).
    pointer('pointerdown', 480, 270);
    pointer('pointerup', 480, 270, { buttons: 0 });
    await settle();
    expect(session.sent[0]).toBe('8|||512|||0|||0|||540');
    keyEvent('keydown', key('KeyA', 'a'));
    await settle();
    const n = session.sent.length;
    select.value = '2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(sentSince(n)).toEqual([packet(2, 0x41, 0x1e, 0x61)]);
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    pointer('pointerdown', 480, 270);
    await settle();
    expect(sentSince(n + 1)).toEqual(['8|||512|||0|||960|||540', `8|||513|||1|||${packedPosition(960, 540)}`]);
    pointer('pointerup', 480, 270, { buttons: 0 });
    select.value = '1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const m = session.sent.length;
    pointer('pointerdown', 480, 270);
    await settle();
    expect(sentSince(m).slice(-2)).toEqual(['8|||512|||0|||-960|||540', `8|||513|||1|||${packedPosition(-960, 540)}`]);
  });

  test('100% scale keeps the canvas at the native crop size and geometry follows its rect', async () => {
    connect();
    const scale = $<HTMLSelectElement>('#scale');
    scale.value = 'actual';
    scale.dispatchEvent(new Event('change', { bubbles: true }));
    expect(canvas.style.width).toBe('1920px');
    expect(canvas.style.height).toBe('1080px');
    // Scrolled: the canvas starts 100 px left of and 50 px above the viewport.
    canvas.getBoundingClientRect = () => DOMRect.fromRect({ x: -100, y: -50, width: 1920, height: 1080 });
    pointer('pointerdown', 10, 10);
    await settle();
    expect(session.sent[0]).toBe('8|||512|||0|||110|||60');
  });

  test('wheel sends one move first, then the wheel, and blocks page scrolling', async () => {
    connect();
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, deltaMode: 1, clientX: 480, clientY: 270 });
    canvas.dispatchEvent(e);
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(session.sent[0]).toBe('8|||512|||0|||960|||540');
    expect(session.sent[1]).toMatch(/^8\|\|\|522\|\|\|/);
    expect(session.sent.length).toBe(2);
  });

  test('context menu is suppressed on the canvas', () => {
    connect();
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  test('Ctrl+Alt+Del sends command 22 through sendCommand with requiresControl', () => {
    connect();
    $<HTMLButtonElement>('[data-special="ctrlAltDel"]').click();
    expect(session.commands).toEqual([{ c: { type: 'action', action: 'ctrlAltDel' }, requiresControl: true }]);
  });

  test('Win, Alt+Tab and PrintScreen are synthetic keyDown/keyUp sequences', async () => {
    connect();
    $<HTMLButtonElement>('[data-special="win"]').click();
    $<HTMLButtonElement>('[data-special="altTab"]').click();
    $<HTMLButtonElement>('[data-special="printScreen"]').click();
    await settle();
    expect(session.sent).toEqual([
      packet(1, 0x5b, 0xe05b), packet(2, 0x5b, 0xe05b),
      packet(3, 0xa4, 0x38), packet(3, 0x09, 0x0f), packet(4, 0x09, 0x0f), packet(4, 0xa4, 0x38),
      packet(1, 0x2c, 0xe037), packet(2, 0x2c, 0xe037),
    ]);
  });

  test('quality, wallpaper and refresh use the session control API', () => {
    connect();
    const quality = $<HTMLSelectElement>('#quality');
    quality.value = 'speed';
    quality.dispatchEvent(new Event('change', { bubbles: true }));
    const wallpaper = $<HTMLInputElement>('#wallpaper');
    wallpaper.checked = true;
    wallpaper.dispatchEvent(new Event('change', { bubbles: true }));
    $<HTMLButtonElement>('#refresh').click();
    expect(session.commands).toEqual([
      { c: { type: 'quality', preset: 'speed' }, requiresControl: false },
      { c: { type: 'wallpaper', visible: false }, requiresControl: true },
    ]);
    expect(session.refreshes).toBe(1);
  });

  test('old Windows UltraViewer (< 6.2.13): no key packets, a notice, mouse still works', async () => {
    connect(peer({ version: '6.2.12', supportsBinaryKeyboard: false }));
    expect($('#notice').textContent).toContain('Máy Windows dùng UltraViewer cũ (< 6.2.13): chỉ điều khiển chuột');
    const e = keyEvent('keydown', key('KeyA', 'a'));
    $<HTMLButtonElement>('[data-special="win"]').click();
    await settle();
    expect(e.defaultPrevented).toBe(false);
    expect(session.sent).toEqual([]);
    expect($<HTMLButtonElement>('[data-special="win"]').disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-special="ctrlAltDel"]').disabled).toBe(false);
    pointer('pointerdown', 480, 270);
    await settle();
    expect(session.sent.length).toBe(2);
  });

  test('Ngắt releases held input before closing the session', async () => {
    connect();
    keyEvent('keydown', key('KeyA', 'a'));
    await settle();
    $<HTMLButtonElement>('#toolbar-disconnect').click();
    await vi.waitFor(() => expect(session.phase).toBe('closed'));
    expect(session.sent.at(-1)).toEqual(packet(2, 0x41, 0x1e, 0x61));
    expect(session.closedAt).toBe(session.sent.length);
    expect($('#connect-form').hidden).toBe(false);
  });

  test('beforeunload asks for confirmation only while connected', () => {
    const idle = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
    connect();
    const busy = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(busy);
    expect(busy.defaultPrevented).toBe(true);
  });

  test('a full input queue releases everything, turns Điều khiển off and shows an error', async () => {
    connect();
    // A send that never completes: the first message stays in flight, the rest pile up.
    session.send = () => new Promise<void>(() => {});
    for (let i = 0; i < 4200; i++) {
      keyEvent('keydown', key('KeyA', 'a'));
      keyEvent('keyup', key('KeyA', 'a'));
    }
    await settle();
    expect($<HTMLButtonElement>('#control-toggle').getAttribute('aria-pressed')).toBe('false');
    expect($('#notice').textContent).toContain('Hàng đợi');
    const e = keyEvent('keydown', key('KeyA', 'a'));
    expect(e.defaultPrevented).toBe(false);
  });

  /** VK_PACKET down/up pairs for each UTF-16 unit of `s`. */
  const vkPacketText = (s: string) => [...s].flatMap((c) => [packet(1, 0xe7, 0, c.charCodeAt(0)), packet(2, 0xe7, 0, c.charCodeAt(0))]);
  const composition = (type: string, data: string) => textarea.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
  const beforeInput = (inputType: string, data: string | null, isComposing = false) =>
    textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data, isComposing }));

  test('macOS Telex: composing keys send nothing, the committed word goes out as VK_PACKET units', async () => {
    connect();
    pointer('pointerdown', 100, 50);
    pointer('pointerup', 100, 50, { buttons: 0 });
    await settle();
    const n = session.sent.length;
    const preview = $<HTMLDivElement>('#composition');
    composition('compositionstart', '');
    const steps: Array<[string, string, string]> = [['KeyV', 'V', 'V'], ['KeyI', 'i', 'Vi'], ['KeyE', 'e', 'Vie'], ['KeyE', 'e', 'Viê'], ['KeyJ', 'j', 'Việ'], ['KeyT', 't', 'Việt']];
    for (const [code, k, marked] of steps) {
      keyEvent('keydown', key(code, k, { keyCode: 229, isComposing: true }));
      beforeInput('insertCompositionText', marked, true);
      composition('compositionupdate', marked);
      keyEvent('keyup', key(code, k, { isComposing: true }));
    }
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toBe('Việt');
    expect(preview.style.left).toBe('100px');
    composition('compositionend', 'Việt');
    await settle();
    expect(sentSince(n)).toEqual(vkPacketText('Việt'));
    expect(preview.hidden).toBe(true);
    expect(textarea.value).toBe('');
  });

  test('soft keyboard text, Backspace and Enter reach the remote', async () => {
    connect();
    beforeInput('insertText', 'ệ');
    beforeInput('deleteContentBackward', null);
    beforeInput('insertLineBreak', null);
    await settle();
    expect(session.sent).toEqual([
      ...vkPacketText('ệ'),
      packet(1, 0x08, 0x0e, 8), packet(2, 0x08, 0x0e, 8),
      packet(1, 0x0d, 0x1c, 13), packet(2, 0x0d, 0x1c, 13),
    ]);
  });

  /** Remounts the page as on macOS (Option types characters) and connects. */
  function mountMac(): void {
    viewer.destroy();
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
    document.body.innerHTML = '<main id="app"></main>';
    app = document.getElementById('app')!;
    viewer = mountViewer(app, { createSession: () => session, workerUrl: 'ws://127.0.0.1:8787', schedule: (cb) => cb() });
    canvas = $<HTMLCanvasElement>('#screen');
    textarea = $<HTMLTextAreaElement>('#keyboard-input');
    connect();
  }

  test('macOS Option+p types "π": Alt is lifted under a Ctrl tap first, then the character', async () => {
    try {
      mountMac();
      keyEvent('keydown', key('AltLeft', 'Alt', { altKey: true }));
      const down = keyEvent('keydown', key('KeyP', 'π', { altKey: true }));
      keyEvent('keyup', key('KeyP', 'π', { altKey: true }));
      keyEvent('keyup', key('AltLeft', 'Alt'));
      await settle();
      expect(down.defaultPrevented).toBe(true);
      expect(session.sent).toEqual([
        packet(3, 0xa4, 0x38),
        packet(3, 0xa2, 0x1d), packet(4, 0xa2, 0x1d), packet(4, 0xa4, 0x38),
        ...vkPacketText('π'),
      ]);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).platform;
    }
  });

  test('a text key whose keyup macOS swallowed under Cmd does not swallow a later plain keyup', async () => {
    try {
      mountMac();
      keyEvent('keydown', key('AltLeft', 'Alt', { altKey: true }));
      keyEvent('keydown', key('KeyP', 'π', { altKey: true }));
      keyEvent('keyup', key('AltLeft', 'Alt'));
      keyEvent('keydown', key('MetaLeft', 'Meta', { metaKey: true }));
      // P released while Cmd is down: macOS sends no keyup for it.
      keyEvent('keyup', key('MetaLeft', 'Meta'));
      await settle();
      const n = session.sent.length;
      keyEvent('keydown', key('KeyP', 'p'));
      keyEvent('keyup', key('KeyP', 'p'));
      await settle();
      expect(sentSince(n)).toEqual([packet(1, 0x50, 0x19, 0x70), packet(2, 0x50, 0x19, 0x70)]);
      // Without Cmd in between: a new VK keydown of the same key also ends the text press.
      keyEvent('keydown', key('AltLeft', 'Alt', { altKey: true }));
      keyEvent('keydown', key('KeyP', 'π', { altKey: true }));
      keyEvent('keyup', key('AltLeft', 'Alt'));
      await settle();
      const m = session.sent.length;
      keyEvent('keydown', key('KeyP', 'p'));
      keyEvent('keyup', key('KeyP', 'p'));
      await settle();
      expect(sentSince(m)).toEqual([packet(1, 0x50, 0x19, 0x70), packet(2, 0x50, 0x19, 0x70)]);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).platform;
    }
  });

  test('text and the composition preview stay local while Điều khiển is off', async () => {
    connect();
    $<HTMLButtonElement>('#control-toggle').click();
    await settle();
    const n = session.sent.length;
    composition('compositionstart', '');
    composition('compositionupdate', 'Vi');
    expect($<HTMLDivElement>('#composition').hidden).toBe(true);
    composition('compositionend', 'Việt');
    beforeInput('insertText', 'ệ');
    await settle();
    expect(session.sent.length).toBe(n);
  });

  test('the bar status block shows the machine name and resolution while connected', () => {
    connect(peer({ displayName: 'DEMO-PC', width: 2560, height: 720 }));
    const status = $('#toolbar #conn-status');
    expect(status.querySelector('.tb-name')!.textContent).toBe('DEMO-PC');
    expect(status.querySelector('.tb-res')!.textContent).toBe('2560×720');
    expect(status.querySelector<HTMLElement>('.tb-dot')!.dataset.tone).toBe('ok');
    expect(status.title).toBe($('#status').textContent);
    expect(status.title).toContain('Đã kết nối tới DEMO-PC');
    // View-only (a notice is shown): amber.
    session.emit({ type: 'inputPermission', allowed: false });
    expect(status.querySelector<HTMLElement>('.tb-dot')!.dataset.tone).toBe('warn');
    session.emit({ type: 'closed', reason: 'partnerEnded' });
    expect(status.querySelector('.tb-name')!.textContent).toBe('');
  });

  test('a peer without a display name is shown as Máy Windows', () => {
    connect(peer({ displayName: '' }));
    expect($('#conn-status .tb-name').textContent).toBe('Máy Windows');
    expect($('#conn-status .tb-res').textContent).toBe('1920×1080');
  });

  test('the connect form collapses once connected and returns after the session closes', () => {
    connect();
    expect($('#connect-form').hidden).toBe(true);
    expect($('#toolbar').hidden).toBe(false);
    session.emit({ type: 'closed', reason: 'partnerEnded' });
    expect($('#connect-form').hidden).toBe(false);
    expect($('#toolbar').hidden).toBe(true);
    expect($('#status').textContent).toBe('Máy Windows đã kết thúc phiên.');
    expect($('#diagnostics').tagName).toBe('DETAILS');
  });
  describe('remote cursor overlay', () => {
    const cur = () => curFile(dib({ width: 2, height: 2, bits: 32, pixelRows: new Array<number>(16).fill(255), maskRows: new Array<number>(8).fill(0) }), 2, 2);
    const requests = () => session.sent.filter((m) => typeof m === 'string' && m.startsWith('4|||'));
    const viewport = () => $<HTMLDivElement>('#viewport');
    const overlayContext = () => {
      const context = { setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), putImageData: vi.fn(), imageSmoothingEnabled: true };
      vi.stubGlobal('ImageData', class { constructor(readonly data: unknown, readonly width: number, readonly height: number) {} });
      vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as never);
      return context;
    };
    const knownShape = (hash = 5) => {
      session.emit({ type: 'cursor', event: { type: 'select', hash } });
      session.emit({ type: 'cursor', event: { type: 'shape', hash, cur: cur() } });
      session.emit({ type: 'cursor', event: { type: 'position', x: 200, y: 100 } });
    };

    afterEach(() => vi.unstubAllGlobals());

    test('a #cursor-layer canvas sits over the screen canvas and ignores the pointer', () => {
      const overlay = $<HTMLCanvasElement>('#cursor-layer');
      expect(overlay.previousElementSibling).toBe(canvas);
      expect(overlay.style.pointerEvents).toBe('none');
      expect(overlay.style.position).toBe('absolute');
    });

    test('an unknown shape is requested once with 4|||hash until it arrives', async () => {
      connect();
      session.emit({ type: 'cursor', event: { type: 'select', hash: -77 } });
      session.emit({ type: 'cursor', event: { type: 'select', hash: -77 } });
      await settle();
      expect(requests()).toEqual(['4|||-77']);
      session.emit({ type: 'cursor', event: { type: 'shape', hash: -77, cur: cur() } });
      session.emit({ type: 'cursor', event: { type: 'select', hash: -77 } });
      await settle();
      expect(requests()).toEqual(['4|||-77']);
    });

    test('an unanswered request is repeated after a screen refresh re-login and after a reconnect', async () => {
      connect();
      session.emit({ type: 'cursor', event: { type: 'select', hash: 9 } });
      session.emit({ type: 'accepted', peer: peer() });
      session.emit({ type: 'cursor', event: { type: 'select', hash: 9 } });
      await settle();
      expect(requests()).toEqual(['4|||9', '4|||9']);
      session.emit({ type: 'closed', reason: 'partnerEnded' });
      connect();
      session.emit({ type: 'cursor', event: { type: 'select', hash: 9 } });
      await settle();
      expect(requests()).toHaveLength(3);
    });

    test('the browser cursor is hidden only while controlling with a known remote shape', () => {
      connect();
      session.emit({ type: 'cursor', event: { type: 'position', x: 200, y: 100 } });
      expect(viewport().classList.contains('controlling')).toBe(false);
      knownShape();
      expect(viewport().classList.contains('controlling')).toBe(true);
      $<HTMLButtonElement>('#control-toggle').click();
      expect(viewport().classList.contains('controlling')).toBe(false);
      $<HTMLButtonElement>('#control-toggle').click();
      expect(viewport().classList.contains('controlling')).toBe(true);
      session.emit({ type: 'inputPermission', allowed: false });
      expect(viewport().classList.contains('controlling')).toBe(false);
      session.emit({ type: 'closed', reason: 'partnerEnded' });
      expect(viewport().classList.contains('controlling')).toBe(false);
    });

    test('view-only users still see the remote pointer drawn at the scaled position', () => {
      const context = overlayContext();
      connect(peer({ allowsRemoteInput: false }));
      session.emit({ type: 'cursor', event: { type: 'position', x: 200, y: 100 } });
      // 1920x1080 into 960x540: scale 0.5; the fallback arrow has its hotspot at 0,0.
      expect(context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 100, 50, 6, 9.5);
      expect(viewport().classList.contains('controlling')).toBe(false);
      expect($<HTMLCanvasElement>('#cursor-layer').style.width).toBe('960px');
    });

    test('choosing another monitor moves or hides the pointer by crop and virtual origin', () => {
      const context = overlayContext();
      const monitors: RemoteMonitor[] = [
        { index: 1, left: -1920, top: 0, right: 0, bottom: 1080 },
        { index: 2, left: 0, top: 0, right: 1920, bottom: 1080 },
      ];
      connect(peer({ width: 3840, height: 1080, virtualLeft: -1920, monitors }));
      session.emit({ type: 'cursor', event: { type: 'position', x: 100, y: 100 } });
      const select = $<HTMLSelectElement>('#monitor');
      select.value = '2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 50, 50, 6, 9.5);
      const calls = context.drawImage.mock.calls.length;
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(context.drawImage.mock.calls.length).toBe(calls); // x=100 is on monitor 2: hidden on monitor 1
    });

    test('nothing is drawn before a position arrives and after the session ends', () => {
      const context = overlayContext();
      connect();
      expect(context.drawImage).not.toHaveBeenCalled(); // accepted, but no remote position yet
      session.emit({ type: 'cursor', event: { type: 'position', x: 200, y: 100 } });
      expect(context.drawImage).toHaveBeenCalledTimes(1);
      session.emit({ type: 'closed', reason: null });
      session.emit({ type: 'cursor', event: { type: 'position', x: 300, y: 100 } });
      expect(context.drawImage).toHaveBeenCalledTimes(1);
    });
  });

  describe('touch (phones and tablets)', () => {
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const tap = (id: number, x: number, y: number) => {
      pointer('pointerdown', x, y, { pointerType: 'touch', pointerId: id });
      pointer('pointerup', x, y, { pointerType: 'touch', pointerId: id, buttons: 0 });
    };
    const touchMove = (id: number, x: number, y: number) => pointer('pointermove', x, y, { pointerType: 'touch', pointerId: id });
    const overlayContext = () => {
      const context = { setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), putImageData: vi.fn(), imageSmoothingEnabled: true };
      vi.stubGlobal('ImageData', class { constructor(readonly data: unknown, readonly width: number, readonly height: number) {} });
      vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as never);
      return context;
    };
    /** Holds the left button through tap, then touch-and-drag to the right. */
    const touchDragStart = () => {
      tap(1, 100, 100);
      pointer('pointerdown', 100, 100, { pointerType: 'touch', pointerId: 1 });
      for (let x = 103; x <= 121; x += 3) touchMove(1, x, 100);
    };

    afterEach(() => vi.unstubAllGlobals());

    test('a touch does not focus the textarea (the soft keyboard opens only from ⌨) and a tap clicks', async () => {
      connect();
      const down = pointer('pointerdown', 480, 270, { pointerType: 'touch' });
      expect(down.defaultPrevented).toBe(true);
      expect(document.activeElement).not.toBe(textarea);
      pointer('pointerup', 480, 270, { pointerType: 'touch', buttons: 0 });
      await settle();
      expect(session.sent).toEqual([]);
      await wait(300);
      expect(session.sent).toEqual([
        '8|||512|||0|||960|||540',
        `8|||513|||1|||${packedPosition(960, 540)}`,
        '8|||512|||1|||960|||540',
        `8|||514|||0|||${packedPosition(960, 540)}`,
      ]);
      expect(document.activeElement).not.toBe(textarea);
    });

    test('a mouse or pen on a touch device keeps the desktop behaviour', async () => {
      connect();
      pointer('pointerdown', 480, 270, { pointerType: 'pen' });
      await settle();
      expect(document.activeElement).toBe(textarea);
      expect(session.sent).toEqual(['8|||512|||0|||960|||540', `8|||513|||1|||${packedPosition(960, 540)}`]);
    });

    test('pointercancel during a touch drag releases everything held', async () => {
      connect();
      touchDragStart();
      await settle();
      expect(session.sent.filter((m) => typeof m === 'string' && m.startsWith('8|||513'))).toHaveLength(1);
      const n = session.sent.length;
      pointer('pointercancel', 121, 100, { pointerType: 'touch', pointerId: 1 });
      await settle();
      expect(sentSince(n).some((m) => typeof m === 'string' && m.startsWith('8|||514|||0|||'))).toBe(true);
    });

    test('switching from the touch trackpad to a mouse releases what the touch held first', async () => {
      connect();
      touchDragStart();
      await settle();
      const n = session.sent.length;
      pointer('pointerdown', 480, 270); // mouse
      await settle();
      const after = sentSince(n) as string[];
      const release = after.findIndex((m) => m.startsWith('8|||514|||'));
      const press = after.findIndex((m) => m.startsWith('8|||513|||'));
      expect(release).toBeGreaterThanOrEqual(0);
      expect(press).toBeGreaterThan(release);
    });

    test('the trackpad moves the overlay pointer at once; a stale host position does not pull it back', async () => {
      const context = overlayContext();
      connect();
      pointer('pointerdown', 100, 100, { pointerType: 'touch' });
      for (let x = 102; x <= 120; x += 2) touchMove(1, x, 100); // 20 css px => 40 remote px
      await settle();
      expect(session.sent.at(-1)).toBe('8|||512|||0|||1000|||540');
      // 1920x1080 in 960x540: scale 0.5; the fallback arrow's hotspot is 0,0.
      expect(context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 500, 270, 6, 9.5);
      session.emit({ type: 'cursor', event: { type: 'position', x: 960, y: 540 } });
      expect(context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 500, 270, 6, 9.5);
      pointer('pointerup', 120, 100, { pointerType: 'touch', buttons: 0 });
      // The host's latest word is applied once the trackpad has been still for a moment.
      session.emit({ type: 'cursor', event: { type: 'position', x: 1002, y: 540 } });
      await wait(600);
      expect(context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 501, 270, 6, 9.5);
    });

    test('floating ⌨ toggles the soft keyboard and Phím opens the special-keys menu', () => {
      connect();
      const keyboard = $<HTMLButtonElement>('[data-touch="keyboard"]');
      keyboard.click();
      expect(document.activeElement).toBe(textarea);
      keyboard.click();
      expect(document.activeElement).not.toBe(textarea);
      $<HTMLButtonElement>('[data-touch="keys"]').click();
      expect($<HTMLDetailsElement>('#special-keys').open).toBe(true);
      // Choosing a key after a touch does not pop the soft keyboard up.
      pointer('pointerdown', 10, 10, { pointerType: 'touch', pointerId: 4 });
      pointer('pointerup', 10, 10, { pointerType: 'touch', pointerId: 4, buttons: 0 });
      $<HTMLButtonElement>('[data-special="win"]').click();
      expect(document.activeElement).not.toBe(textarea);
    });

    test('pinch-zoom is local, and mouse clicks and the overlay stay aligned under it', async () => {
      const context = overlayContext();
      connect();
      const wrapper = $<HTMLDivElement>('#zoom');
      // The wrapper and the canvas fill a 960x540 viewport at the origin; their rects follow the transform.
      const rect = () => {
        const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(wrapper.style.transform);
        const [tx, ty, s] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1];
        return DOMRect.fromRect({ x: tx, y: ty, width: 960 * s, height: 540 * s });
      };
      wrapper.getBoundingClientRect = rect;
      canvas.getBoundingClientRect = rect;
      pointer('pointerdown', 380, 270, { pointerType: 'touch', pointerId: 1 });
      pointer('pointerdown', 580, 270, { pointerType: 'touch', pointerId: 2 });
      for (let i = 1; i <= 10; i++) {
        touchMove(1, 380 - i * 10, 270);
        touchMove(2, 580 + i * 10, 270);
      }
      pointer('pointerup', 280, 270, { pointerType: 'touch', pointerId: 1, buttons: 0 });
      pointer('pointerup', 680, 270, { pointerType: 'touch', pointerId: 2, buttons: 0 });
      await settle();
      expect(session.sent).toEqual([]);
      expect(wrapper.style.transform).toBe('translate(-480px, -270px) scale(2)');
      // Mouse at the viewport's top-left now points at remote (480, 270), its centre at the remote centre.
      pointer('pointerdown', 0, 0);
      pointer('pointerup', 0, 0, { buttons: 0 });
      pointer('pointerdown', 480, 270);
      await settle();
      expect(session.sent).toContain(`8|||513|||1|||${packedPosition(480, 270)}`);
      expect(session.sent.at(-1)).toBe(`8|||513|||1|||${packedPosition(960, 540)}`);
      // The overlay, inside the wrapper, keeps its layout size: remote (480, 270) is drawn at layout
      // (240, 135), which the transform puts at client (0, 0) - where the mouse pointed.
      session.emit({ type: 'cursor', event: { type: 'position', x: 480, y: 270 } });
      expect($<HTMLCanvasElement>('#cursor-layer').style.width).toBe('960px');
      expect(context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 240, 135, 6, 9.5);
      // A new scale mode or the end of the session resets the zoom.
      const scale = $<HTMLSelectElement>('#scale');
      scale.value = 'actual';
      scale.dispatchEvent(new Event('change', { bubbles: true }));
      expect(wrapper.style.transform).toBe('');
    });
  });
  describe('phase 1 final review fixes', () => {
    const MONITORS: RemoteMonitor[] = [
      { index: 1, left: 0, top: 0, right: 960, bottom: 1080 },
      { index: 2, left: 960, top: 0, right: 1920, bottom: 1080 },
    ];
    const change = (el: HTMLElement) => el.dispatchEvent(new Event('change', { bubbles: true }));

    test('after every toolbar action the keyboard textarea has focus again (non-touch)', () => {
      connect(peer({ monitors: MONITORS }));
      const actions: Array<[string, () => void, HTMLElement]> = [
        ['monitor', () => { const s = $<HTMLSelectElement>('#monitor'); s.value = '2'; change(s); }, $('#monitor')],
        ['scale', () => { const s = $<HTMLSelectElement>('#scale'); s.value = 'actual'; change(s); }, $('#scale')],
        ['quality', () => { const s = $<HTMLSelectElement>('#quality'); s.value = 'speed'; change(s); }, $('#quality')],
        ['wallpaper', () => { const c = $<HTMLInputElement>('#wallpaper'); c.checked = true; change(c); }, $('#wallpaper')],
        ['refresh', () => $<HTMLButtonElement>('#refresh').click(), $('#refresh')],
      ];
      for (const [name, act, control] of actions) {
        control.focus();
        expect(document.activeElement, `${name}: control focused before`).toBe(control);
        act();
        expect(document.activeElement, `${name}: textarea focused after`).toBe(textarea);
      }
    });

    test('after a touch the toolbar actions do not pop the soft keyboard up', () => {
      connect();
      pointer('pointerdown', 10, 10, { pointerType: 'touch' });
      pointer('pointerup', 10, 10, { pointerType: 'touch', buttons: 0 });
      $<HTMLButtonElement>('#refresh').click();
      expect(document.activeElement).not.toBe(textarea);
    });

    test('toolbar buttons do not take focus on mousedown (so Space/Enter never re-trigger them)', () => {
      connect();
      for (const id of ['#refresh', '#control-toggle', '#fullscreen', '[data-special="win"]']) {
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        $(id).dispatchEvent(down);
        expect(down.defaultPrevented, id).toBe(true);
      }
      // A select must still open on mousedown.
      const select = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      $('#quality').dispatchEvent(select);
      expect(select.defaultPrevented).toBe(false);
    });

    const touchTap = async () => {
      pointer('pointerdown', 480, 270, { pointerType: 'touch', pointerId: 5 });
      pointer('pointerup', 480, 270, { pointerType: 'touch', pointerId: 5, buttons: 0 });
      await new Promise<void>((r) => setTimeout(r, 300));
      await settle();
    };
    const clicks = () => session.sent.filter((m) => typeof m === 'string' && m.startsWith('8|||513'));

    test('window blur mid-touch forgets the finger: the next single tap still clicks', async () => {
      connect();
      pointer('pointerdown', 100, 100, { pointerType: 'touch', pointerId: 4 }); // never lifted
      window.dispatchEvent(new Event('blur'));
      await touchTap();
      expect(clicks()).toHaveLength(1);
    });

    test('the page hidden mid-touch forgets the finger', async () => {
      connect();
      pointer('pointerdown', 100, 100, { pointerType: 'touch', pointerId: 4 });
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      vi.restoreAllMocks();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
      await touchTap();
      expect(clicks()).toHaveLength(1);
    });

    test('a session that closed mid-touch does not leave a stale finger for the next session', async () => {
      connect();
      pointer('pointerdown', 100, 100, { pointerType: 'touch', pointerId: 4 });
      session.emit({ type: 'closed', reason: 'partnerEnded' });
      connect();
      await touchTap();
      expect(clicks()).toHaveLength(1);
    });

    test('the page refuses to connect in an insecure context and says why', () => {
      viewer.destroy();
      const sessions: number[] = [];
      viewer = mountViewer(app, {
        createSession: () => { sessions.push(1); return session; },
        workerUrl: 'ws://127.0.0.1:8787',
        insecureNotice: 'NOTICE-VN',
        schedule: (cb) => cb(),
      });
      const notice = $('#env-notice');
      expect(notice.hidden).toBe(false);
      expect(notice.textContent).toBe('NOTICE-VN');
      expect($<HTMLButtonElement>('#connect').disabled).toBe(true);
      $<HTMLInputElement>('#partner').value = '123456789';
      $<HTMLInputElement>('#password').value = 'abc';
      $<HTMLFormElement>('#connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
      expect(sessions).toEqual([]);
      expect($('#status').textContent).toBe('NOTICE-VN');
    });

    test('there is no Worker token field; the session is created with the Worker URL only', () => {
      expect(app.querySelector('#token')).toBeNull();
      const created: unknown[] = [];
      viewer.destroy();
      viewer = mountViewer(app, {
        createSession: (o) => { created.push(o); return session; },
        workerUrl: 'ws://127.0.0.1:8787',
        schedule: (cb) => cb(),
      });
      $<HTMLInputElement>('#partner').value = '123456789';
      $<HTMLInputElement>('#password').value = 'abc';
      $<HTMLFormElement>('#connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
      expect(created).toEqual([{ workerUrl: 'ws://127.0.0.1:8787' }]);
    });

    test('a Worker token left in either storage by an older version is deleted on load', () => {
      viewer.destroy();
      localStorage.setItem('uvweb.token', 'legacy-local');
      sessionStorage.setItem('uvweb.token', 'legacy-session');
      localStorage.setItem('uvweb.clipboard', '1');
      viewer = mountViewer(app, { createSession: () => session, workerUrl: 'ws://127.0.0.1:8787', schedule: (cb) => cb() });
      expect(localStorage.getItem('uvweb.token')).toBeNull();
      expect(sessionStorage.getItem('uvweb.token')).toBeNull();
      expect(localStorage.getItem('uvweb.clipboard')).toBe('1');
    });

    test('a secure context shows no environment notice', () => {
      expect($('#env-notice').hidden).toBe(true);
      expect($<HTMLButtonElement>('#connect').disabled).toBe(false);
    });
  });
});
