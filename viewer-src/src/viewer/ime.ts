// Keyboard routing for the hidden textarea laid over the remote screen (ruling P1-R1).
// Task 4 scope: key routing only. Non-text keys and printable keys typed on a physical key
// go to `key` (the VK path); a keydown that belongs to an IME composition (`isComposing`,
// key 'Process', keyCode 229) is never routed, because the composed text will arrive
// separately. A keyup is always routed so a held key can always be released.
// Task 5 extends this module with compositionend / beforeinput -> `text`.

export interface TextInputHandlers {
  /** A physical key went down (`down`) or up. The handler decides preventDefault. */
  key(e: KeyboardEvent, down: boolean): void;
  /** Composed or virtual-keyboard text (Task 5). */
  text(s: string): void;
}

/** keyCode 229: the key event is being processed by an IME. */
const IME_KEY_CODE = 229;

export function isComposingKey(e: KeyboardEvent): boolean {
  return e.isComposing || e.key === 'Process' || e.keyCode === IME_KEY_CODE;
}

/** Routes the textarea's key events; returns a function that detaches every listener. */
export function attachTextInput(el: HTMLTextAreaElement, h: TextInputHandlers): () => void {
  let composing = false;
  const onKeyDown = (e: KeyboardEvent) => {
    if (isComposingKey(e)) return;
    h.key(e, true);
  };
  const onKeyUp = (e: KeyboardEvent) => h.key(e, false);
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    el.value = '';
  };
  // Keys that reach the textarea's default action (unmapped, or control off) must not pile up text.
  const onInput = (e: Event) => {
    if (!composing && !(e as InputEvent).isComposing) el.value = '';
  };

  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('keyup', onKeyUp);
  el.addEventListener('compositionstart', onCompositionStart);
  el.addEventListener('compositionend', onCompositionEnd);
  el.addEventListener('input', onInput);
  return () => {
    el.removeEventListener('keydown', onKeyDown);
    el.removeEventListener('keyup', onKeyUp);
    el.removeEventListener('compositionstart', onCompositionStart);
    el.removeEventListener('compositionend', onCompositionEnd);
    el.removeEventListener('input', onInput);
  };
}
