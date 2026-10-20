// Desktop mouse/keyboard capture on the remote screen: DOM events -> InputEncoder ->
// InputQueue -> session.send. Owns the stuck-input rules (Review Focus 1, ruling P1-R8):
// blur / visibilitychange hidden / pagehide / disable / stop enqueue `releaseAll()` behind
// whatever is pending (FIFO, never `queue.clear()`); only a queue overflow clears, then
// releases, then reports so the page can turn Điều khiển off.
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

function isButton(b: number): b is PointerButton {
  return b === 0 || b === 1 || b === 2;
}

export interface DesktopInputOptions {
  canvas: HTMLCanvasElement;
  textarea: HTMLTextAreaElement;
  view: () => View;
  /** The queue filled: held input was released; the page must turn control off and say so. */
  onOverflow: () => void;
  /** A send failed (once per started sink). */
  onSendError: (e: unknown) => void;
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
  private readonly detachers: Array<() => void> = [];

  constructor(private readonly o: DesktopInputOptions) {
    const { canvas, textarea } = o;
    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.listen(canvas, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.listen(canvas, 'pointerup', (e) => this.onPointerUp(e as PointerEvent));
    this.listen(canvas, 'pointercancel', () => this.push(this.encoder?.pointerMove(NO_POINT, 0) ?? []));
    // Keep focus on the textarea: the canvas is not focusable, its default mousedown would blur it.
    this.listen(canvas, 'mousedown', (e) => e.preventDefault());
    this.listen(canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
    this.listen(textarea, 'blur', () => this.releaseAll());
    this.listen(window, 'blur', () => this.releaseAll());
    this.listen(window, 'pagehide', () => this.releaseAll());
    this.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.releaseAll();
    });
    this.detachers.push(
      attachTextInput(textarea, {
        key: (e, down) => this.onKey(e, down),
        text: (s) => {
          if (this.keyboardActive()) this.push(this.encoder!.text(s));
        },
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

  private keyboardActive(): boolean {
    return this.active() && this.binaryKeyboard;
  }

  private onPointerDown(e: PointerEvent): void {
    this.focusKeyboard();
    if (!this.active() || !isButton(e.button)) return;
    e.preventDefault();
    const p = toRemote(e.clientX, e.clientY, this.o.view());
    if (!p) return;
    try {
      this.o.canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is best effort (synthetic or already-released pointers).
    }
    this.push(this.encoder!.pointerDown(e.button, p));
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.active()) return;
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
    if (!this.active() || !isButton(e.button)) return;
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
    if (codeToKey(e.code) !== null) e.preventDefault();
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
