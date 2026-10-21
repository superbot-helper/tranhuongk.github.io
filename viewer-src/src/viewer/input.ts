// Desktop mouse/keyboard capture on the remote screen: DOM events -> InputEncoder ->
// InputQueue -> session.send. Owns the stuck-input rules (Review Focus 1, ruling P1-R8):
// blur / visibilitychange hidden / pagehide / disable / stop enqueue `releaseAll()` behind
// whatever is pending (FIFO, never `queue.clear()`); only a queue overflow clears, then
// releases, then reports so the page can turn Điều khiển off.
// Touch pointers (pointerType 'touch') are left to viewer/touch.ts (trackpad mode), which comes
// back through the trackpad* methods; a real mouse or pen keeps the desktop path here. Switching
// between the two releases everything held first.
// Paste (Task 5, Review Focus 1): the platform's own paste shortcut (⌘V on Apple platforms, Ctrl+V
// elsewhere) is kept off the VK path (⌘ is Win there: Win+V would open the Windows clipboard history)
// and left to the browser, whose `paste` event on the textarea hands the text to `onPaste` (clipboard
// sync); a Ctrl+V combination is then typed on Windows. The other combination (Ctrl+V on a Mac) is an
// ordinary remote shortcut. When no `paste` follows (empty pasteboard, a browser that fires none)
// Ctrl+V is typed anyway after PASTE_FALLBACK_MS, or at once when ⌘ goes up first (a lone Win
// press-release would open the Start menu).
import { InputEncoder, type InputMessage, type KeyInput, type PointerButton, type WheelMode } from '../input/encoder';
import { toRemote, type View } from '../input/geometry';
import { codeToKey } from '../input/keymap';
import { InputQueue } from '../input/queue';
import { attachTextInput } from './ime';

export interface InputSink {
  send(bytes: Uint8Array, formatFlag?: boolean): Promise<void>;
}

export type SyntheticKey = 'win' | 'altTab' | 'altF4' | 'ctrlEsc' | 'printScreen';

type Step = { code: string; key: string; down: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean };

const press = (code: string, key: string, mods: Omit<Step, 'code' | 'key' | 'down'> = {}): Step[] => [
  { code, key, down: true, ...mods },
  { code, key, down: false, ...mods },
];

/** Shortcuts the browser or the local OS would swallow, as keyDown/keyUp sequences with consistent flags. */
export const SYNTHETIC_SEQUENCES: Record<SyntheticKey, Step[]> = {
  win: [
    { code: 'MetaLeft', key: 'Meta', down: true, meta: true },
    { code: 'MetaLeft', key: 'Meta', down: false },
  ],
  altTab: [
    { code: 'AltLeft', key: 'Alt', down: true, alt: true },
    ...press('Tab', 'Tab', { alt: true }),
    { code: 'AltLeft', key: 'Alt', down: false },
  ],
  altF4: [
    { code: 'AltLeft', key: 'Alt', down: true, alt: true },
    ...press('F4', 'F4', { alt: true }),
    { code: 'AltLeft', key: 'Alt', down: false },
  ],
  ctrlEsc: [
    { code: 'ControlLeft', key: 'Control', down: true, ctrl: true },
    ...press('Escape', 'Escape', { ctrl: true }),
    { code: 'ControlLeft', key: 'Control', down: false },
  ],
  printScreen: press('PrintScreen', 'PrintScreen'),
};

const WHEEL_MODES: readonly WheelMode[] = ['pixel', 'line', 'page'];
/** MouseEvent.buttons bit per MouseEvent.button (0 left, 1 middle, 2 right). */
const BUTTON_BITS: Record<number, number> = { 0: 1, 1: 4, 2: 2 };
const NO_POINT = { x: Number.NaN, y: Number.NaN };
const FLUSH_WAIT_TICKS = 50;

const ascii = new TextEncoder();

/** Wait for the browser's `paste` after an intercepted paste keydown before typing Ctrl+V anyway. */
export const PASTE_FALLBACK_MS = 150;
/** A `paste` this soon after the fallback typed Ctrl+V uploads only (no second Ctrl+V). */
const PASTE_LATE_MS = 1_000;

function defaultApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /Mac|iPhone|iPad|iPod|macOS|iOS/i.test(data?.platform || navigator.platform || '');
}

/** The browser's paste shortcut: ⌘V on Apple platforms, Ctrl+V elsewhere (Shift allowed), not AltGr+V. */
function isPasteShortcut(e: KeyboardEvent, apple: boolean): boolean {
  if (e.code !== 'KeyV' || e.altKey) return false;
  return apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

function isButton(b: number): b is PointerButton {
  return b === 0 || b === 1 || b === 2;
}

export interface DesktopInputOptions {
  canvas: HTMLCanvasElement;
  textarea: HTMLTextAreaElement;
  /** Local preview of uncommitted IME text (never sent), inside the textarea's positioned parent. */
  composition?: HTMLElement;
  view: () => View;
  /** The queue filled: held input was released; the page must turn control off and say so. */
  onOverflow: () => void;
  /** A send failed (once per started sink). */
  onSendError: (e: unknown) => void;
  /**
   * The user pasted while controlling: `text` is the local clipboard's text/plain ('' when none).
   * Resolve true to type Ctrl+V on Windows afterwards (default when absent).
   */
  onPaste?: (text: string) => boolean | Promise<boolean>;
  /** ⌘V (true) or Ctrl+V (false) is the local paste shortcut; detected from the platform by default. */
  applePlatform?: boolean;
  capacity?: number;
}

export class DesktopInput {
  private encoder: InputEncoder | null = null;
  private queue: InputQueue | null = null;
  private sink: InputSink | null = null;
  private enabled = false;
  private capsLock = false;
  private binaryKeyboard = false;
  /** Bumped on overflow so the rest of an in-progress batch is dropped (its keys were just released). */
  private overflows = 0;
  /** Which path pressed or moved last: switching paths releases what the other one held. */
  private pointerPath: 'desktop' | 'trackpad' | null = null;
  /** Where the last press landed, relative to the composition preview's parent: the remote caret is likely there. */
  private caretHint: { x: number; y: number } | null = null;
  /** Keys whose keydown was sent as text: their keyup (still flagged Alt) must not press Alt again. */
  private readonly textKeys = new Set<string>();
  private readonly detachers: Array<() => void> = [];
  private readonly apple: boolean;
  /** Types Ctrl+V if the browser's `paste` does not follow an intercepted paste keydown. */
  private pasteFallback: ReturnType<typeof setTimeout> | null = null;
  /** performance.now() when the fallback last typed Ctrl+V. */
  private fallbackAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly o: DesktopInputOptions) {
    const { canvas, textarea } = o;
    this.apple = o.applePlatform ?? defaultApplePlatform();
    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.listen(canvas, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.listen(canvas, 'pointerup', (e) => this.onPointerUp(e as PointerEvent));
    this.listen(canvas, 'pointercancel', (e) => {
      if ((e as PointerEvent).pointerType !== 'touch') this.push(this.encoder?.pointerMove(NO_POINT, 0) ?? []);
    });
    // Keep focus on the textarea: the canvas is not focusable, its default mousedown would blur it.
    this.listen(canvas, 'mousedown', (e) => e.preventDefault());
    this.listen(canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
    this.listen(textarea, 'blur', () => this.releaseAll());
    this.listen(textarea, 'paste', (e) => void this.onPaste(e as ClipboardEvent));
    this.listen(window, 'blur', () => this.releaseAll());
    this.listen(window, 'pagehide', () => this.releaseAll());
    this.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.releaseAll();
    });
    this.detachers.push(
      attachTextInput(textarea, {
        key: (e, down) => this.onKey(e, down),
        text: (s, source) => this.onText(s, source),
        marked: (s) => this.showMarked(s),
      }),
    );
  }

  /** A new peer (or a changed keyboard capability): fresh encoder and queue for `sink`. */
  start(sink: InputSink, o: { binaryKeyboard: boolean }): void {
    this.releaseAll();
    this.sink = sink;
    this.encoder = new InputEncoder({ binaryKeyboard: o.binaryKeyboard });
    this.binaryKeyboard = o.binaryKeyboard;
    let reported = false;
    const queue: InputQueue = new InputQueue(
      (m) => sink.send(typeof m === 'string' ? ascii.encode(m) : m, false),
      () => this.overflow(queue),
      this.o.capacity,
      (e) => {
        if (reported) return;
        reported = true;
        this.o.onSendError(e);
      },
    );
    this.queue = queue;
  }

  get started(): boolean {
    return this.encoder !== null;
  }

  get supportsKeyboard(): boolean {
    return this.binaryKeyboard;
  }

  /** Effective control (local toggle, host permission, session active). Turning it off releases held input. */
  setEnabled(enabled: boolean): void {
    if (this.enabled && !enabled) this.releaseAll();
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Enqueue a release of every held key and button behind what is pending. */
  releaseAll(): void {
    this.cancelPasteFallback();
    this.textKeys.clear();
    if (this.encoder && this.queue) this.pushRaw(this.encoder.releaseAll());
  }

  /** Release held input and forget the sink (session ended). */
  stop(): void {
    this.releaseAll();
    this.enabled = false;
    this.encoder = null;
    this.queue = null;
    this.sink = null;
  }

  /** Resolves once every queued message was handed to the sink (bounded wait). */
  async flush(): Promise<void> {
    for (let i = 0; i < FLUSH_WAIT_TICKS && (this.queue?.length ?? 0) > 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    // The drain starts on a microtask: give a just-pushed burst that chance.
    await Promise.resolve();
    for (let i = 0; i < FLUSH_WAIT_TICKS && (this.queue?.length ?? 0) > 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** Types a shortcut the local browser/OS would intercept (Win, Alt+Tab, ...). */
  sendSynthetic(name: SyntheticKey): void {
    if (!this.keyboardActive()) return;
    const encoder = this.encoder!;
    for (const step of SYNTHETIC_SEQUENCES[name]) {
      const input: KeyInput = {
        code: step.code,
        key: step.key,
        ctrl: step.ctrl === true,
        alt: step.alt === true,
        meta: step.meta === true,
        shift: false,
        capsLock: this.capsLock,
        repeat: false,
      };
      this.push(step.down ? encoder.keyDown(input) : encoder.keyUp(input));
    }
  }

  /**
   * Ctrl+V on Windows. A Ctrl the user already holds stays held. After ⌘V the Win key is down on
   * the remote: Ctrl goes down while it is still held (so lifting Win alone does not open the Start
   * menu), then V's own flags lift Win before V is pressed.
   */
  sendPasteShortcut(): void {
    if (!this.keyboardActive()) return;
    const encoder = this.encoder!;
    const ctrlHeld = encoder.holdsModifier('control');
    const base = { shift: false, alt: false, capsLock: this.capsLock, repeat: false };
    const ctrl = { ...base, code: 'ControlLeft', key: 'Control' };
    const v = { ...base, code: 'KeyV', key: 'v', ctrl: true, meta: false };
    const out: InputMessage[] = [];
    if (!ctrlHeld) out.push(...encoder.keyDown({ ...ctrl, ctrl: true, meta: encoder.holdsModifier('command') }));
    out.push(...encoder.keyDown(v), ...encoder.keyUp(v));
    if (!ctrlHeld) out.push(...encoder.keyUp({ ...ctrl, ctrl: false, meta: false }));
    this.push(out);
  }

  /** Trackpad mode (touch): move the remote pointer to `p` (wire coordinates). False when not sent. */
  trackpadMove(p: { x: number; y: number }): boolean {
    if (!this.useTrackpad()) return false;
    this.push(this.encoder!.pointerMove(p));
    return true;
  }

  /** Trackpad mode: press or release `button` at `p` (a move is sent first by the encoder). */
  trackpadButton(button: PointerButton, down: boolean, p: { x: number; y: number }): boolean {
    if (!this.useTrackpad()) return false;
    this.push(down ? this.encoder!.pointerDown(button, p) : this.encoder!.pointerUp(button, p));
    return true;
  }

  /** Trackpad mode: two-finger scroll, CSS px in WheelEvent convention (pixel mode, 40 px per notch). */
  trackpadWheel(deltaY: number): boolean {
    if (!this.useTrackpad()) return false;
    this.push(this.encoder!.wheel(deltaY, 'pixel'));
    return true;
  }

  focusKeyboard(): void {
    if (document.activeElement !== this.o.textarea) this.o.textarea.focus({ preventScroll: true });
  }

  detach(): void {
    this.stop();
    for (const d of this.detachers.splice(0)) d();
  }

  // --- events -----------------------------------------------------------------------------

  private active(): boolean {
    return this.enabled && this.encoder !== null;
  }

  private usePath(path: 'desktop' | 'trackpad'): void {
    if (this.pointerPath !== null && this.pointerPath !== path) this.releaseAll();
    this.pointerPath = path;
  }

  private useTrackpad(): boolean {
    if (!this.active()) return false;
    this.usePath('trackpad');
    return true;
  }

  private keyboardActive(): boolean {
    return this.active() && this.binaryKeyboard;
  }

  private onPointerDown(e: PointerEvent): void {
    // Touch never focuses the textarea: the soft keyboard opens only from the ⌨ button.
    if (e.pointerType === 'touch') return;
    this.focusKeyboard();
    const parent = this.o.composition?.parentElement;
    if (parent) {
      const r = parent.getBoundingClientRect();
      this.caretHint = { x: e.clientX - r.left + parent.scrollLeft, y: e.clientY - r.top + parent.scrollTop };
    }
    if (!this.active() || !isButton(e.button)) return;
    e.preventDefault();
    const p = toRemote(e.clientX, e.clientY, this.o.view());
    if (!p) return;
    this.usePath('desktop');
    try {
      this.o.canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is best effort (synthetic or already-released pointers).
    }
    this.push(this.encoder!.pointerDown(e.button, p));
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.active() || e.pointerType === 'touch') return;
    const encoder = this.encoder!;
    const p = toRemote(e.clientX, e.clientY, this.o.view(), e.buttons !== 0);
    // A chorded button change arrives as a pointermove with `button` set.
    if (isButton(e.button) && p && (e.buttons & (BUTTON_BITS[e.button] ?? 0)) !== 0) {
      this.push(encoder.pointerDown(e.button, p));
      return;
    }
    // Moves outside the image are dropped, but held buttons whose bit is gone are still released.
    this.push(encoder.pointerMove(p ?? NO_POINT, e.buttons));
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.active() || e.pointerType === 'touch' || !isButton(e.button)) return;
    e.preventDefault();
    const p = toRemote(e.clientX, e.clientY, this.o.view(), true);
    this.push(this.encoder!.pointerUp(e.button, p ?? NO_POINT));
    try {
      if (e.buttons === 0) this.o.canvas.releasePointerCapture?.(e.pointerId);
    } catch {
      // Not captured.
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!this.active()) return;
    e.preventDefault();
    const encoder = this.encoder!;
    const p = toRemote(e.clientX, e.clientY, this.o.view(), e.buttons !== 0);
    if (!p) return;
    // The wheel message carries the last pointer position: move there first.
    this.push(encoder.pointerMove(p, e.buttons));
    this.push(encoder.wheel(e.deltaY, WHEEL_MODES[e.deltaMode] ?? 'pixel'));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    this.capsLock = e.getModifierState?.('CapsLock') ?? this.capsLock;
    if (!this.keyboardActive()) return;
    if (down && isPasteShortcut(e, this.apple)) {
      // Not prevented: the browser's paste runs and `paste` follows (onPaste). Its keyup is dropped.
      this.textKeys.add(e.code);
      this.cancelPasteFallback();
      const encoder = this.encoder;
      this.pasteFallback = setTimeout(() => {
        this.pasteFallback = null;
        if (this.encoder === encoder) this.fallbackPaste();
      }, PASTE_FALLBACK_MS);
      return;
    }
    // ⌘ (Win) going up while the fallback waits: Ctrl+V first, so Win is not pressed alone.
    if (!down && this.pasteFallback !== null && (e.code === 'MetaLeft' || e.code === 'MetaRight')) {
      this.cancelPasteFallback();
      this.fallbackPaste();
    }
    if (codeToKey(e.code) !== null) e.preventDefault();
    // A new keydown ends an earlier text press of the same key; macOS drops keyups of keys released
    // under Cmd (the encoder releases them on Meta up), so Meta up forgets every text press too.
    if (down) this.textKeys.delete(e.code);
    else if (this.textKeys.delete(e.code)) return;
    else if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.textKeys.clear();
    const input: KeyInput = {
      code: e.code,
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      shift: e.shiftKey,
      capsLock: this.capsLock,
      repeat: e.repeat,
    };
    this.push(down ? this.encoder!.keyDown(input) : this.encoder!.keyUp(input));
  }

  private async onPaste(e: ClipboardEvent): Promise<void> {
    // The textarea only captures keys: pasted text never lands in it.
    e.preventDefault();
    const late = this.pasteFallback === null && performance.now() - this.fallbackAt < PASTE_LATE_MS;
    this.cancelPasteFallback();
    this.fallbackAt = Number.NEGATIVE_INFINITY;
    if (!this.active()) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const encoder = this.encoder;
    const proceed = this.o.onPaste ? await this.o.onPaste(text) : true;
    // The upload may have taken a while: only type into the same, still controlled, session.
    if (proceed && !late && this.encoder === encoder && this.active()) this.sendPasteShortcut();
  }

  private fallbackPaste(): void {
    this.fallbackAt = performance.now();
    this.sendPasteShortcut();
  }

  private cancelPasteFallback(): void {
    if (this.pasteFallback !== null) clearTimeout(this.pasteFallback);
    this.pasteFallback = null;
  }

  private onText(s: string, source?: KeyboardEvent): void {
    if (!this.keyboardActive()) return;
    const encoder = this.encoder!;
    if (source && (source.altKey || source.ctrlKey)) {
      // Option / AltGr typed this character but is held on the remote too, where Alt+char is a menu
      // shortcut (WM_SYSCHAR): lift the modifiers first. A lone Alt going up opens the menu bar, so a
      // Ctrl tap goes under it first (an Alt+Ctrl press-release does nothing on Windows).
      const base = { key: source.key, shift: source.shiftKey, meta: false, capsLock: this.capsLock, repeat: false };
      if (source.altKey && !source.ctrlKey) {
        this.push(encoder.keyDown({ ...base, code: 'ControlLeft', key: 'Control', ctrl: true, alt: true }));
        this.push(encoder.keyUp({ ...base, code: 'ControlLeft', key: 'Control', ctrl: false, alt: true }));
      }
      this.push(encoder.keyUp({ ...base, code: source.code, ctrl: false, alt: false }));
      this.textKeys.add(source.code);
    }
    this.push(encoder.text(s));
  }

  private showMarked(s: string): void {
    const box = this.o.composition;
    if (!box) return;
    const visible = s !== '' && this.keyboardActive();
    box.textContent = visible ? s : '';
    box.hidden = !visible;
    if (!visible || !this.caretHint) return;
    const parent = box.parentElement;
    const maxLeft = parent?.clientWidth ? parent.scrollLeft + parent.clientWidth - box.offsetWidth : Infinity;
    box.style.left = `${Math.max(0, Math.min(this.caretHint.x, maxLeft))}px`;
    box.style.top = `${Math.max(0, this.caretHint.y + 12)}px`;
  }

  // --- queue ------------------------------------------------------------------------------

  private push(messages: readonly InputMessage[]): void {
    const queue = this.queue;
    if (!queue) return;
    const generation = this.overflows;
    for (const m of messages) {
      if (this.overflows !== generation) return;
      queue.push(m);
    }
  }

  private pushRaw(messages: readonly InputMessage[]): void {
    for (const m of messages) this.queue?.push(m);
  }

  private overflow(queue: InputQueue): void {
    this.overflows++;
    queue.clear();
    if (this.encoder) for (const m of this.encoder.releaseAll()) queue.push(m);
    this.enabled = false;
    this.o.onOverflow();
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.detachers.push(() => target.removeEventListener(type, fn, opts));
  }
}
