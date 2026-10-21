// Port of MacViewer's MacRemoteInputEncoder (state machine) and RemoteScroll, driven by
// browser KeyboardEvent.code instead of macOS kVK codes. Pure: no DOM. The caller
// checks authentication and input permission, then sends the returned messages in
// order: strings as ASCII and Uint8Arrays as binary, both with formatFlag=false.
import { keyboardPacket } from '../proto/keyboard';
import type { KeyboardKind } from '../proto/keyboard';
import { MouseButtonMessage, mouseButtonText, mouseMoveText, mouseWheelText, packedPosition, wheelWParam } from '../proto/mouse';
import { codeToKeyInfo } from './keymap';
import type { KeyInfo } from './keymap';

/** Subset of KeyboardEvent the encoder needs. */
export interface KeyInput {
  code: string;
  key: string;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
  capsLock: boolean;
  repeat: boolean;
}

export type WheelMode = 'pixel' | 'line' | 'page';
/** Browser MouseEvent.button: 0 left, 1 middle, 2 right. */
export type PointerButton = 0 | 1 | 2;
export type InputMessage = string | Uint8Array;

type ModifierGroup = 'shift' | 'control' | 'option' | 'command';
const GROUPS: readonly ModifierGroup[] = ['shift', 'control', 'option', 'command'];
const GROUP_KEYS: Record<ModifierGroup, { left: string; right: string }> = {
  shift: { left: 'ShiftLeft', right: 'ShiftRight' },
  control: { left: 'ControlLeft', right: 'ControlRight' },
  option: { left: 'AltLeft', right: 'AltRight' },
  command: { left: 'MetaLeft', right: 'MetaRight' },
};

const VK_PACKET = 0xe7;
const INT32_MAX = 0x7fffffff;
const INT32_MIN = -0x80000000;
const MAX_NOTCHES = 256;

interface HeldKey {
  info: KeyInfo;
  character: number;
  /** Alt held when pressed (or the Alt key itself): wire kinds 3/4. */
  system: boolean;
  /** Guessed from a modifier flag rather than a concrete key event. */
  synthetic: boolean;
}

interface Point {
  x: number;
  y: number;
}

interface Modifiers {
  shift: boolean;
  control: boolean;
  option: boolean;
  command: boolean;
  capsLock: boolean;
}

/** Swift RemoteScroll.detents with sensitivity 1, in browser WheelEvent units. Positive deltaY scrolls down. */
export function wheelNotches(deltaY: number, mode: WheelMode): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (mode === 'page') return deltaY * 3;
  return deltaY / (mode === 'pixel' ? 40 : 3);
}

// Swift `Int16(truncatingIfNeeded:)`.
function truncateInt16(value: number): number {
  return (value << 16) >> 16;
}

/** Swift `Point(exactly:)` failed on non-Int32 input; here finite values are truncated and clamped, NaN is rejected. */
function toPoint(p: { x: number; y: number }): Point | null {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: clampInt32(Math.trunc(p.x)), y: clampInt32(Math.trunc(p.y)) };
}

function clampInt32(value: number): number {
  return Math.min(INT32_MAX, Math.max(INT32_MIN, value));
}

function packed(p: Point | null): number {
  return p ? packedPosition(truncateInt16(p.x), truncateInt16(p.y)) : 0;
}

function groupOf(code: string): ModifierGroup | null {
  for (const group of GROUPS) {
    const keys = GROUP_KEYS[group];
    if (keys.left === code || keys.right === code) return group;
  }
  return null;
}

function buttonMessages(button: number): { down: MouseButtonMessage; up: MouseButtonMessage; flag: number } | null {
  switch (button) {
    case 0:
      return { down: MouseButtonMessage.LeftDown, up: MouseButtonMessage.LeftUp, flag: 0x01 };
    case 2:
      return { down: MouseButtonMessage.RightDown, up: MouseButtonMessage.RightUp, flag: 0x02 };
    case 1:
      return { down: MouseButtonMessage.MiddleDown, up: MouseButtonMessage.MiddleUp, flag: 0x10 };
    default:
      return null;
  }
}

// MouseEvent.buttons bit for a MouseEvent.button value.
const BUTTONS_BIT: Record<number, number> = { 0: 1, 1: 4, 2: 2 };

export class InputEncoder {
  private readonly binaryKeyboard: boolean;
  private readonly keys = new Map<string, HeldKey>();
  private keyOrder: string[] = [];
  private buttons: number[] = [];
  private modifiers: Modifiers = { shift: false, control: false, option: false, command: false, capsLock: false };
  private pointer: Point | null = null;
  private lastMoveFlags: number | null = null;
  private wheelRemainder = 0;
  /** Caps Lock state this encoder last toggled the remote to (assumed off at start). */
  private remoteCaps = false;

  /** `binaryKeyboard` is the negotiated capability (peer >= 6.2.13); it is not inferred here. */
  constructor(o: { binaryKeyboard: boolean }) {
    this.binaryKeyboard = o.binaryKeyboard;
  }

  keyDown(e: KeyInput): Uint8Array[] {
    return this.key(e, true);
  }

  keyUp(e: KeyInput): Uint8Array[] {
    return this.key(e, false);
  }

  /** Composed text (IME, virtual keyboards) typed as VK_PACKET down/up pairs, one per UTF-16 unit. */
  text(s: string): Uint8Array[] {
    if (!this.binaryKeyboard) return [];
    const out: Uint8Array[] = [];
    for (let i = 0; i < s.length; i++) {
      const unit = s.charCodeAt(i);
      if (unit < 0x20 || (unit >= 0xd800 && unit <= 0xdfff)) continue;
      for (const kind of [1, 2] as const) {
        out.push(keyboardPacket({ kind, vk: VK_PACKET, scan: 0, character: unit, capsLock: this.modifiers.capsLock }));
      }
    }
    return out;
  }

  /**
   * `buttons` is MouseEvent.buttons when known: a held button whose bit is absent was
   * released outside the page, so its up message is emitted (after the move) to avoid a stuck button.
   */
  pointerMove(p: { x: number; y: number }, buttons?: number): string[] {
    const out: string[] = [];
    const point = toPoint(p);
    if (point) this.move(point, false, out);
    if (buttons !== undefined) {
      for (const held of [...this.buttons].reverse()) {
        if (((buttons & (BUTTONS_BIT[held] ?? 0)) === 0)) this.releaseButton(held, out);
      }
    }
    return out;
  }

  pointerDown(button: PointerButton, p: { x: number; y: number }): string[] {
    return this.pointerButton(button, true, p);
  }

  pointerUp(button: PointerButton, p: { x: number; y: number }): string[] {
    return this.pointerButton(button, false, p);
  }

  /** Vertical wheel only. Positive deltaY (scroll down) becomes a negative wheel delta. */
  wheel(deltaY: number, mode: WheelMode): string[] {
    if (!Number.isFinite(deltaY)) return [];
    const detents = -wheelNotches(deltaY, mode); // may overflow to +-Infinity: the clamp below handles it
    const total = this.wheelRemainder + Math.min(MAX_NOTCHES, Math.max(-MAX_NOTCHES, detents));
    const steps = Math.trunc(total);
    this.wheelRemainder = total - steps;
    if (steps === 0) return [];
    return [mouseWheelText(wheelWParam(steps * 120, this.mouseFlags()), packed(this.pointer))];
  }

  /** A key of this modifier group is down on the remote side. */
  holdsModifier(group: 'shift' | 'control' | 'option' | 'command'): boolean {
    return this.holds(group);
  }

  /**
   * Release everything held: ordinary keys (reverse press order) while modifiers stay down,
   * then mouse buttons (reverse press order), then keys still held (modifiers, reverse order).
   */
  releaseAll(): InputMessage[] {
    const out: InputMessage[] = [];
    for (const code of [...this.keyOrder].reverse().filter((c) => groupOf(c) === null)) this.releaseKey(code, out);
    for (const button of [...this.buttons].reverse()) this.releaseButton(button, out);
    for (const code of [...this.keyOrder].reverse()) this.releaseKey(code, out);
    this.modifiers = { shift: false, control: false, option: false, command: false, capsLock: this.modifiers.capsLock };
    this.wheelRemainder = 0;
    return out;
  }

  // --- keyboard -----------------------------------------------------------------------------

  private key(e: KeyInput, pressed: boolean): Uint8Array[] {
    const out: Uint8Array[] = [];
    const group = groupOf(e.code);
    // Only a keydown can be skipped: a keyup must always be able to release a held key.
    if (pressed && e.key === 'Process') return out; // IME composition: the text arrives via text()
    this.modifiers = {
      shift: e.shift,
      control: e.ctrl,
      option: e.alt,
      command: e.meta,
      capsLock: e.capsLock,
    };
    // A pressed modifier is down by definition, whatever the flags of a sloppy caller say.
    if (group && pressed) this.modifiers[group] = true;
    if (!this.binaryKeyboard) return out;
    this.reconcileModifiers(group, out);
    const info = codeToKeyInfo(e.code);
    if (!info) return out;
    if (group) {
      if (pressed) {
        // A concrete hardware side replaces an earlier guessed side of the same group.
        for (const other of [...this.keyOrder]) {
          if (other !== e.code && groupOf(other) === group && this.keys.get(other)?.synthetic) this.releaseKey(other, out);
        }
        const held = this.keys.get(e.code);
        if (held?.synthetic) held.synthetic = false;
        else if (!held) this.pressKey(e.code, info, 0, false, out);
        // Held and concrete: a modifier auto-repeat sends nothing.
      } else {
        // The browser drops keyup for other keys while Meta is down (macOS): release them first.
        if (group === 'command' && !this.holdsOther('command', e.code)) this.releaseOrdinaryKeys(out);
        this.releaseKey(e.code, out);
      }
      this.reconcileModifier(group, pressed ? null : e.code, out);
    } else if (e.code === 'CapsLock') {
      // macOS reports keydown only when turning Caps Lock on and keyup only when turning it off; PCs report
      // both for each press. Windows toggles on key-down, so tap once whenever the reported state differs
      // from the remote state we last set (ruling P1-R9).
      if (e.capsLock !== this.remoteCaps) {
        this.remoteCaps = e.capsLock;
        this.pressKey(e.code, info, 0, false, out);
        this.releaseKey(e.code, out);
      }
    } else if (pressed) {
      this.pressKey(e.code, info, this.characterFor(info, e), false, out);
    } else {
      this.releaseKey(e.code, out);
    }
    return out;
  }

  private characterFor(info: KeyInfo, e: KeyInput): number {
    // Shortcut modifiers select the physical VK path in the host.
    if (e.ctrl || e.alt || e.meta) return 0;
    if (info.control !== undefined) return info.control;
    if (!info.text || e.key.length !== 1) return 0;
    const unit = e.key.charCodeAt(0);
    return unit >= 0x20 && unit <= 0x7e ? unit : 0;
  }

  private holds(group: ModifierGroup): boolean {
    return this.keyOrder.some((c) => groupOf(c) === group);
  }

  private holdsOther(group: ModifierGroup, except: string): boolean {
    return this.keyOrder.some((c) => c !== except && groupOf(c) === group);
  }

  private reconcileModifiers(excluding: ModifierGroup | null, out: Uint8Array[]): void {
    for (const group of GROUPS) {
      if (group !== excluding) this.reconcileModifier(group, null, out);
    }
  }

  private reconcileModifier(group: ModifierGroup, avoiding: string | null, out: Uint8Array[]): void {
    if (!this.modifiers[group]) {
      for (const code of [...this.keyOrder]) {
        if (groupOf(code) === group) this.releaseKey(code, out);
      }
    } else if (!this.holds(group)) {
      const keys = GROUP_KEYS[group];
      const code = keys.left === avoiding ? keys.right : keys.left;
      const info = codeToKeyInfo(code);
      if (info) this.pressKey(code, info, 0, true, out);
    }
  }

  private pressKey(code: string, info: KeyInfo, character: number, synthetic: boolean, out: Uint8Array[]): void {
    const system = groupOf(code) === 'option' || this.holds('option');
    if (!this.keys.has(code)) this.keyOrder.push(code);
    const held: HeldKey = { info, character, system, synthetic };
    this.keys.set(code, held);
    out.push(this.packet(held, true));
  }

  private releaseKey(code: string, out: InputMessage[]): void {
    const held = this.keys.get(code);
    if (!held) return;
    this.keys.delete(code);
    this.keyOrder = this.keyOrder.filter((c) => c !== code);
    out.push(this.packet(held, false));
  }

  private releaseOrdinaryKeys(out: Uint8Array[]): void {
    for (const code of [...this.keyOrder].reverse()) {
      if (groupOf(code) === null) this.releaseKey(code, out);
    }
  }

  private packet(held: HeldKey, pressed: boolean): Uint8Array {
    const kind = (held.system ? (pressed ? 3 : 4) : pressed ? 1 : 2) as KeyboardKind;
    return keyboardPacket({
      kind,
      vk: held.info.vk,
      scan: held.info.scan,
      character: held.character,
      capsLock: this.modifiers.capsLock,
    });
  }

  // --- mouse --------------------------------------------------------------------------------

  private pointerButton(button: number, pressed: boolean, p: { x: number; y: number }): string[] {
    const messages = buttonMessages(button);
    if (!messages || pressed === this.buttons.includes(button)) return [];
    const out: string[] = [];
    const point = toPoint(p);
    if (point) this.move(point, pressed, out);
    else if (pressed) return [];
    if (pressed) {
      this.buttons.push(button);
      out.push(mouseButtonText(messages.down, this.mouseFlags(), packed(this.pointer)));
    } else {
      this.releaseButton(button, out);
    }
    return out;
  }

  private releaseButton(button: number, out: InputMessage[]): void {
    const messages = buttonMessages(button);
    if (!messages || !this.buttons.includes(button)) return;
    this.buttons = this.buttons.filter((b) => b !== button);
    out.push(mouseButtonText(messages.up, this.mouseFlags(), packed(this.pointer)));
  }

  private move(point: Point, force: boolean, out: string[]): void {
    const flags = this.mouseFlags();
    const p = this.pointer;
    if (force || !p || p.x !== point.x || p.y !== point.y || this.lastMoveFlags !== flags) {
      out.push(mouseMoveText(flags, point.x, point.y));
      this.lastMoveFlags = flags;
    }
    this.pointer = point;
  }

  private mouseFlags(): number {
    let flags = 0;
    for (const b of this.buttons) flags |= buttonMessages(b)?.flag ?? 0;
    if (this.modifiers.shift || this.holds('shift')) flags |= 0x04;
    if (this.modifiers.control || this.holds('control')) flags |= 0x08;
    return flags;
  }
}
