// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RemoteCommand, RemoteMonitor } from '../proto/commands';
import { packedPosition } from '../proto/mouse';
import type { ConnectOptions, Peer, SessionDiagnostics, SessionEvent, SessionPhase } from '../session/relay-session';
import { mountViewer, type ViewerHandle, type ViewerSession } from './viewer';

// The jsdom (web) transform refuses the bundled *.pem?raw trust anchors (Vite fs.deny); the
// page under test never opens TLS, so the trust module is stubbed.
vi.mock('../net/trust', () => ({ checkServerChain: vi.fn(), defaultAnchors: () => [] }));

const DIAGNOSTICS: SessionDiagnostics = {
  registrationAccepted: false, assignedID: null, lookupStatus: null, peerTransportOpened: false,
  loginSent: false, peerAccepted: false, decodedFrames: 0, decodeMsTotal: 0, decodeMsMax: 0,
  screenPayloadBytes: 0, screenRefreshes: 0, lastScreenFailure: null, relayKeepalivesSent: 0,
  commandKeepalivesSent: 0, relayPongs: 0, relayRttMs: null, peerRttMs: null, ignoredMessages: 0,
  ignoredSources: 0,
};

/** Records what the viewer sends; the test drives session events by hand. */
class TestSession implements ViewerSession {
  phase: SessionPhase = 'closed';
  readonly diagnostics = DIAGNOSTICS;
  /** ASCII messages as text, binary keyboard packets as number arrays. */
  readonly sent: Array<string | number[]> = [];
  readonly commands: Array<{ c: RemoteCommand; requiresControl: boolean }> = [];
  refreshes = 0;
  closedAt = -1;
  options: ConnectOptions | null = null;
  private on: ((e: SessionEvent) => void) | null = null;

  connect(o: ConnectOptions, on: (e: SessionEvent) => void): void {
    this.options = o;
    this.on = on;
    this.phase = 'registering';
  }

  async send(bytes: Uint8Array, formatFlag = false): Promise<void> {
    if (this.phase === 'closed') throw new Error('notConnected');
    expect(formatFlag).toBe(false);
    this.sent.push(bytes[0] === 30 ? [...bytes] : new TextDecoder().decode(bytes));
  }

  async sendCommand(c: RemoteCommand, opts: { requiresControl: boolean }): Promise<void> {
    this.commands.push({ c, requiresControl: opts.requiresControl });
  }

  async refreshScreen(): Promise<void> {
    this.refreshes++;
  }

  close(): void {
    this.closedAt = this.sent.length;
    this.phase = 'closed';
    this.on?.({ type: 'closed', reason: null });
  }

  emit(e: SessionEvent): void {
    if (e.type === 'accepted') this.phase = 'active';
    if (e.type === 'closed') this.phase = 'closed';
    this.on?.(e);
  }
}

function peer(over: Partial<Peer> = {}): Peer {
  return {
    displayName: 'PC',
    version: '6.6.0',
    width: 1920,
    height: 1080,
    virtualLeft: 0,
    virtualTop: 0,
    supportsBinaryKeyboard: true,
    allowsRemoteInput: true,
    monitors: [],
    ...over,
  };
}

const key = (code: string, key: string, over: Partial<KeyInit> = {}): KeyInit => ({ code, key, ...over });
type KeyInit = KeyboardEventInit & { code: string; key: string };

/** Keyboard packet `[30,|,|,|, kind, vk, scanLE, charLE, caps]`. */
const packet = (kind: number, vk: number, scan: number, char = 0) => [30, 124, 124, 124, kind, vk, scan & 0xff, scan >> 8, char & 0xff, char >> 8, 0];

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('desktop viewer page', () => {
  let session: TestSession;
  let app: HTMLElement;
  let viewer: ViewerHandle;
  let canvas: HTMLCanvasElement;
  let textarea: HTMLTextAreaElement;

  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

  function connect(p: Peer = peer()): void {
    $<HTMLInputElement>('#token').value = 'x'.repeat(32);
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

  test('macOS Option+p types "π": Alt is lifted under a Ctrl tap first, then the character', async () => {
    viewer.destroy();
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
    try {
      document.body.innerHTML = '<main id="app"></main>';
      app = document.getElementById('app')!;
      viewer = mountViewer(app, { createSession: () => session, workerUrl: 'ws://127.0.0.1:8787', schedule: (cb) => cb() });
      canvas = $<HTMLCanvasElement>('#screen');
      textarea = $<HTMLTextAreaElement>('#keyboard-input');
      connect();
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
});
