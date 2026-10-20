// Keyboard and text routing for the hidden textarea laid over the remote screen (ruling P1-R1).
//
// Two outputs: `key` (the physical VK path, Task 4) and `text` (VK_PACKET units, Task 5).
//   - Non-text keys, shortcuts (Ctrl / Meta / Windows Alt) and an ASCII character produced by its own
//     US-position key go to `key`, so an input method running on the Windows side (Unikey) still sees keys.
//   - Any other character typed directly (international layouts, macOS Option, AltGr, a soft keyboard
//     whose keydown carries the character) goes to `text`, and the keydown's default is blocked so the
//     browser does not insert it a second time.
//   - An IME composition (`isComposing`, key 'Process', keyCode 229, dead keys) never sends a key: only its
//     committed text is sent (compositionend), while the marked text is reported for a local preview.
//   - Soft keyboards without key events use beforeinput: insertText / insertReplacementText / a committed
//     insertCompositionText -> `text`; deleteContentBackward -> Backspace; insertLineBreak/Paragraph -> Enter.
// A keyup is always routed so a held key can always be released. The textarea is emptied after every
// commit so later beforeinput data is a clean delta.

export interface TextInputHandlers {
  /** A physical key went down (`down`) or up. The handler decides preventDefault. */
  key(e: KeyboardEvent, down: boolean): void;
  /**
   * Committed text. `source` is the keydown that typed it directly (no IME), whose modifiers
   * (Option, AltGr) may still be held on the remote side.
   */
  text(s: string, source?: KeyboardEvent): void;
  /** Uncommitted composition text, shown locally only; '' hides it. */
  marked?(s: string): void;
}

export interface TextInputOptions {
  /** Option/Alt + key types a character (macOS) rather than being an Alt shortcut (Windows, Linux). */
  optionTypesText?: boolean;
}

/** keyCode 229: the key event is being processed by an IME. */
const IME_KEY_CODE = 229;

export function isComposingKey(e: KeyboardEvent): boolean {
  return e.isComposing || e.key === 'Process' || e.keyCode === IME_KEY_CODE;
}

/** Named `key` values ('Enter', 'ArrowLeft', 'F5', 'Unidentified'...), as opposed to produced text. */
const NAMED_KEY = /^[A-Z][A-Za-z0-9]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/** Named keys a soft keyboard may report with an empty `code` (Android), routed as that code. */
const NAMED_KEY_CODES = new Set([
  'Backspace', 'Enter', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
]);

/** Characters each US-position key produces (unshifted, shifted); letters are matched case-insensitively. */
const US_KEYS: Record<string, string> = {
  Digit1: '1!', Digit2: '2@', Digit3: '3#', Digit4: '4$', Digit5: '5%', Digit6: '6^', Digit7: '7&', Digit8: '8*',
  Digit9: '9(', Digit0: '0)', Minus: '-_', Equal: '=+', BracketLeft: '[{', BracketRight: ']}', Backslash: '\\|',
  Semicolon: ';:', Quote: '\'"', Backquote: '`~', Comma: ',<', Period: '.>', Slash: '/?', Space: ' ',
  NumpadDecimal: '.', NumpadMultiply: '*', NumpadAdd: '+', NumpadSubtract: '-', NumpadDivide: '/', NumpadEqual: '=',
  NumpadComma: ',',
};

/** The ASCII character is what this physical key types on a US layout (the host maps VKs as US). */
function matchesPhysicalKey(code: string, ch: string): boolean {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return ch.toUpperCase() === letter[1];
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return ch === numpad[1];
  return US_KEYS[code]?.includes(ch) ?? false;
}

function defaultOptionTypesText(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');
}

type CommitSource = 'composition' | 'input';

/** Routes the textarea's key, composition and beforeinput events; returns a function that detaches them. */
export function attachTextInput(el: HTMLTextAreaElement, h: TextInputHandlers, o: TextInputOptions = {}): () => void {
  const optionTypesText = o.optionTypesText ?? defaultOptionTypesText();
  let composing = false;
  let capsLock = false;
  /** `key` of the keydown being handled (until its keyup): a beforeinput for the same action is a duplicate. */
  let inFlight: string | null = null;
  /** The last commit and its source in this task: the other source repeating it is dropped once. */
  let lastCommit: { text: string; from: CommitSource } | null = null;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let shownMarked = '';

  const setMarked = (s: string) => {
    if (s === shownMarked) return;
    shownMarked = s;
    h.marked?.(s);
  };

  const clear = () => {
    const focused = document.activeElement === el;
    if (el.value !== '') el.value = '';
    el.setSelectionRange(0, 0);
    if (focused && document.activeElement !== el) el.focus({ preventScroll: true });
  };

  const commit = (s: string, from: CommitSource, source?: KeyboardEvent) => {
    if (!s) return;
    if (lastCommit && lastCommit.text === s && lastCommit.from !== from) {
      lastCommit = null;
      return;
    }
    lastCommit = { text: s, from };
    if (commitTimer !== null) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      lastCommit = null;
      commitTimer = null;
    }, 0);
    h.text(s, source);
  };

  const synthetic = (type: string, name: string, from?: KeyboardEvent) =>
    new KeyboardEvent(type, {
      code: name,
      key: name,
      cancelable: true,
      shiftKey: from?.shiftKey ?? false,
      ctrlKey: from?.ctrlKey ?? false,
      altKey: from?.altKey ?? false,
      metaKey: from?.metaKey ?? false,
      repeat: from?.repeat ?? false,
      modifierCapsLock: capsLock,
    });

  const routeKey = (e: KeyboardEvent, down: boolean) => {
    const named = (e.code === '' || e.code === 'Unidentified') && NAMED_KEY_CODES.has(e.key);
    const routed = named ? synthetic(e.type, e.key, e) : e;
    h.key(routed, down);
    if (routed !== e && routed.defaultPrevented) e.preventDefault();
  };

  /** A whole key press for an action that came without key events (soft keyboard). */
  const tap = (name: string) => {
    h.key(synthetic('keydown', name), true);
    h.key(synthetic('keyup', name), false);
  };

  /** The text this keydown types directly, or null when it belongs on the VK path. */
  const directText = (e: KeyboardEvent): string | null => {
    const k = e.key;
    if (k === '' || NAMED_KEY.test(k) || CONTROL_CHAR.test(k) || e.metaKey) return null;
    const altGr = e.ctrlKey && e.altKey;
    if (e.ctrlKey && !altGr) return null; // Ctrl shortcuts, whatever the layout prints
    if (e.altKey && !altGr && !optionTypesText) return null; // Windows Alt shortcuts never type
    const ascii = k.length === 1 && k.charCodeAt(0) < 0x7f;
    if (ascii && e.altKey && !altGr) return null; // Option + ASCII: the Alt shortcut
    if (ascii && matchesPhysicalKey(e.code, k)) return null; // plain typing: real keys (Unikey on the remote)
    return k;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    capsLock = e.getModifierState('CapsLock');
    inFlight = null;
    // The composed text arrives separately; a dead key is half of a character, not Alt+key.
    if (isComposingKey(e) || e.key === 'Dead') return;
    inFlight = e.key;
    const text = directText(e);
    if (text === null) {
      routeKey(e, true);
      return;
    }
    e.preventDefault();
    commit(text, 'input', e);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    capsLock = e.getModifierState('CapsLock');
    if (inFlight === e.key) inFlight = null;
    routeKey(e, false);
  };

  const onCompositionStart = () => {
    composing = true;
    inFlight = null;
    setMarked('');
  };

  const onCompositionUpdate = (e: CompositionEvent) => setMarked(e.data ?? '');

  const onCompositionEnd = (e: CompositionEvent) => {
    composing = false;
    inFlight = null;
    setMarked('');
    commit(e.data ?? '', 'composition');
    clear();
  };

  const onBeforeInput = (ev: Event) => {
    const e = ev as InputEvent;
    const data = e.data ?? '';
    const inComposition = composing || e.isComposing;
    switch (e.inputType) {
      case 'insertCompositionText':
      case 'insertFromComposition':
        // Marked text until compositionend; outside a composition it is already committed.
        if (inComposition) setMarked(data);
        else commit(data, 'input');
        return;
      case 'insertText':
      case 'insertReplacementText':
        if (e.isComposing || (inFlight !== null && data === inFlight)) return;
        commit(data, 'input');
        return;
      case 'deleteContentBackward':
        if (inComposition || inFlight === 'Backspace') return;
        e.preventDefault();
        tap('Backspace');
        return;
      case 'insertLineBreak':
      case 'insertParagraph':
        if (inComposition || inFlight === 'Enter') return;
        e.preventDefault();
        tap('Enter');
        return;
      default:
        return;
    }
  };

  // Whatever reached the textarea outside a composition has been handled: keep it empty.
  const onInput = (e: Event) => {
    if (!composing && !(e as InputEvent).isComposing) clear();
  };

  const onBlur = () => {
    // Browsers commit (compositionend) before blur; a composition still open is abandoned.
    composing = false;
    inFlight = null;
    setMarked('');
  };

  const listeners: Array<[string, EventListener]> = [
    ['keydown', onKeyDown as EventListener],
    ['keyup', onKeyUp as EventListener],
    ['compositionstart', onCompositionStart],
    ['compositionupdate', onCompositionUpdate as EventListener],
    ['compositionend', onCompositionEnd as EventListener],
    ['beforeinput', onBeforeInput],
    ['input', onInput],
    ['blur', onBlur],
  ];
  for (const [type, fn] of listeners) el.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of listeners) el.removeEventListener(type, fn);
    if (commitTimer !== null) clearTimeout(commitTimer);
    setMarked('');
  };
}
