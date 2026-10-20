// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { attachTextInput } from './ime';

describe('attachTextInput (key routing)', () => {
  let el: HTMLTextAreaElement;
  let keys: Array<[string, boolean]>;
  let texts: string[];
  let detach: () => void;

  beforeEach(() => {
    el = document.createElement('textarea');
    document.body.append(el);
    keys = [];
    texts = [];
    detach = attachTextInput(el, { key: (e, down) => keys.push([e.code, down]), text: (s) => texts.push(s) });
  });

  afterEach(() => {
    detach();
    el.remove();
  });

  const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit) =>
    el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));

  test('routes ordinary keys down and up', () => {
    key('keydown', { code: 'KeyA', key: 'a' });
    key('keyup', { code: 'KeyA', key: 'a' });
    key('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' });
    expect(keys).toEqual([['KeyA', true], ['KeyA', false], ['ArrowLeft', true]]);
    expect(texts).toEqual([]);
  });

  test('ignores keydown during composition but always routes keyup', () => {
    key('keydown', { code: 'KeyV', key: 'v', isComposing: true });
    key('keydown', { code: 'KeyE', key: 'Process' });
    key('keydown', { code: 'KeyE', key: 'e', keyCode: 229 });
    key('keyup', { code: 'KeyE', key: 'e', isComposing: true });
    expect(keys).toEqual([['KeyE', false]]);
  });

  test('detach stops routing', () => {
    detach();
    key('keydown', { code: 'KeyA', key: 'a' });
    expect(keys).toEqual([]);
  });

  test('clears stray textarea content outside composition', () => {
    el.value = 'x';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x', inputType: 'insertText' }));
    expect(el.value).toBe('');
  });
});

describe('attachTextInput (text: IME, soft keyboards)', () => {
  let el: HTMLTextAreaElement;
  /** Everything the handlers saw, in order: `key:<code>:down|up`, `text:<s>`. */
  let log: string[];
  let marked: string[];
  let detach: () => void;

  const attach = (opts?: { optionTypesText?: boolean }) => {
    detach?.();
    detach = attachTextInput(
      el,
      {
        key: (e, down) => log.push(`key:${e.code}:${down ? 'down' : 'up'}`),
        text: (s) => log.push(`text:${s}`),
        marked: (s) => marked.push(s),
      },
      opts,
    );
  };

  beforeEach(() => {
    el = document.createElement('textarea');
    document.body.append(el);
    log = [];
    marked = [];
    attach();
    el.focus();
  });

  afterEach(() => {
    detach();
    el.remove();
  });

  const keydown = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };
  const keyup = (init: KeyboardEventInit) =>
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init }));
  /** beforeinput then (unless cancelled) the DOM change the browser would make, then input. */
  const typeInput = (inputType: string, data: string | null, isComposing = false) => {
    const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data, isComposing });
    el.dispatchEvent(before);
    if (before.defaultPrevented) return before;
    if (inputType.startsWith('insert') && data) el.value += data;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data, isComposing }));
    return before;
  };
  const composition = (type: 'compositionstart' | 'compositionupdate' | 'compositionend', data: string) =>
    el.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
  /** One composing keystroke as Chrome reports it: keydown 229, the marked text update, keyup. */
  const composeKey = (code: string, key: string, markedText: string) => {
    keydown({ code, key, keyCode: 229, isComposing: true });
    el.value = '';
    typeInput('insertCompositionText', markedText, true);
    composition('compositionupdate', markedText);
    keyup({ code, key, isComposing: true });
  };

  test('macOS Telex "Vieejt": only text("Việt"), no VK for the letters, marked text shown then cleared', () => {
    keydown({ code: 'KeyV', key: 'V', keyCode: 229, shiftKey: true });
    composition('compositionstart', '');
    typeInput('insertCompositionText', 'V', true);
    composition('compositionupdate', 'V');
    keyup({ code: 'KeyV', key: 'V', shiftKey: true });
    composeKey('KeyI', 'i', 'Vi');
    composeKey('KeyE', 'e', 'Vie');
    composeKey('KeyE', 'e', 'Viê');
    composeKey('KeyJ', 'j', 'Việ');
    composeKey('KeyT', 't', 'Việt');
    composition('compositionend', 'Việt');
    expect(log.filter((l) => !l.endsWith(':up'))).toEqual(['text:Việt']);
    expect(marked).toEqual(['V', 'Vi', 'Vie', 'Viê', 'Việ', 'Việt', '']);
    expect(el.value).toBe('');
    expect(el.selectionStart).toBe(0);
  });

  test('macOS Telex: the space that commits the word arrives as insertText after compositionend', () => {
    composition('compositionstart', '');
    composeKey('KeyA', 'a', 'á');
    keydown({ code: 'Space', key: ' ', keyCode: 229, isComposing: true });
    composition('compositionend', 'á');
    typeInput('insertText', ' ');
    keyup({ code: 'Space', key: ' ' });
    expect(log.filter((l) => l.startsWith('text:'))).toEqual(['text:á', 'text: ']);
    expect(log).not.toContain('key:Space:down');
    expect(el.value).toBe('');
  });

  test('a cancelled composition (compositionend with no data) sends nothing and clears the preview', () => {
    composition('compositionstart', '');
    composeKey('KeyA', 'a', 'a');
    composition('compositionend', '');
    expect(log.filter((l) => l.startsWith('text:'))).toEqual([]);
    expect(marked.at(-1)).toBe('');
  });

  test('iOS soft keyboard: beforeinput insertText "ệ" sends text("ệ") and leaves the textarea empty', () => {
    typeInput('insertText', 'ệ');
    expect(log).toEqual(['text:ệ']);
    expect(el.value).toBe('');
  });

  test('iOS soft keyboard with a keydown carrying the character: sent once, the default is blocked', () => {
    const down = keydown({ code: '', key: 'ệ' });
    if (!down.defaultPrevented) typeInput('insertText', 'ệ');
    keyup({ code: '', key: 'ệ' });
    expect(down.defaultPrevented).toBe(true);
    expect(log.filter((l) => l.startsWith('text:'))).toEqual(['text:ệ']);
  });

  test('insertReplacementText sends the replacement', () => {
    typeInput('insertReplacementText', 'Việt');
    expect(log).toEqual(['text:Việt']);
  });

  test('Android Gboard: keydown 229 + insertCompositionText + compositionend sends the word exactly once', () => {
    const word = ['v', 'vi', 'vie', 'viê', 'việ', 'việt'];
    keydown({ code: '', key: 'Unidentified', keyCode: 229 });
    composition('compositionstart', '');
    for (const w of word) {
      if (w !== 'v') keydown({ code: '', key: 'Unidentified', keyCode: 229 });
      el.value = '';
      typeInput('insertCompositionText', w, true);
      composition('compositionupdate', w);
      keyup({ code: '', key: 'Unidentified', keyCode: 229 });
    }
    composition('compositionend', 'việt');
    // Gboard's auto-space after a suggestion.
    keydown({ code: '', key: 'Unidentified', keyCode: 229 });
    typeInput('insertText', ' ');
    expect(log.filter((l) => l.startsWith('text:'))).toEqual(['text:việt', 'text: ']);
    expect(log.filter((l) => l.endsWith(':down'))).toEqual([]);
    expect(el.value).toBe('');
  });

  test('a committed word is sent once when both compositionend and beforeinput report it', () => {
    composition('compositionstart', '');
    composeKey('KeyA', 'a', 'Việt');
    composition('compositionend', 'Việt');
    typeInput('insertText', 'Việt');
    expect(log.filter((l) => l.startsWith('text:'))).toEqual(['text:Việt']);
  });

  test('Safari commit order (insertFromComposition before compositionend) sends once', () => {
    composition('compositionstart', '');
    composeKey('KeyA', 'a', 'Việt');
    typeInput('deleteCompositionText', null, true);
    typeInput('insertFromComposition', 'Việt', true);
    composition('compositionend', 'Việt');
    expect(log.filter((l) => l.startsWith('text:'))).toEqual(['text:Việt']);
  });

  test('insertCompositionText committed outside a composition is sent, and a late compositionend does not repeat it', () => {
    typeInput('insertCompositionText', 'ơ', false);
    composition('compositionend', 'ơ');
    expect(log.filter((l) => l.startsWith('text:'))).toEqual(['text:ơ']);
  });

  test('the same text typed twice in separate tasks is sent twice', async () => {
    typeInput('insertText', 'a');
    await new Promise((r) => setTimeout(r, 5));
    typeInput('insertText', 'a');
    expect(log).toEqual(['text:a', 'text:a']);
  });

  test('deleteContentBackward (soft keyboard) is a Backspace VK down/up', () => {
    keydown({ code: '', key: 'Unidentified', keyCode: 229 });
    typeInput('deleteContentBackward', null);
    expect(log).toEqual(['key:Backspace:down', 'key:Backspace:up']);
  });

  test('deleteContentBackward inside a composition only edits the marked text', () => {
    composition('compositionstart', '');
    composeKey('KeyA', 'a', 'vi');
    typeInput('deleteContentBackward', null, true);
    expect(log.filter((l) => l.endsWith(':down'))).toEqual([]);
  });

  test('a real Backspace keydown goes the VK path once even if the browser still fires deleteContentBackward', () => {
    keydown({ code: 'Backspace', key: 'Backspace', keyCode: 8 });
    typeInput('deleteContentBackward', null);
    keyup({ code: 'Backspace', key: 'Backspace', keyCode: 8 });
    expect(log).toEqual(['key:Backspace:down', 'key:Backspace:up']);
  });

  test('Android hardware-style keys with an empty code are routed by their key name', () => {
    keydown({ code: '', key: 'Backspace', keyCode: 8 });
    keyup({ code: '', key: 'Backspace', keyCode: 8 });
    keydown({ code: '', key: 'Enter', keyCode: 13 });
    typeInput('insertLineBreak', null);
    keyup({ code: '', key: 'Enter', keyCode: 13 });
    expect(log).toEqual(['key:Backspace:down', 'key:Backspace:up', 'key:Enter:down', 'key:Enter:up']);
  });

  test('insertLineBreak / insertParagraph from a soft keyboard are Enter VK down/up', () => {
    typeInput('insertLineBreak', null);
    typeInput('insertParagraph', null);
    expect(log).toEqual(['key:Enter:down', 'key:Enter:up', 'key:Enter:down', 'key:Enter:up']);
  });

  test("plain 'a' without IME goes the VK path, never as text", () => {
    const down = keydown({ code: 'KeyA', key: 'a', keyCode: 65 });
    // Control off: the key handler does not block the default, so the browser inserts it.
    if (!down.defaultPrevented) typeInput('insertText', 'a');
    keyup({ code: 'KeyA', key: 'a', keyCode: 65 });
    expect(log).toEqual(['key:KeyA:down', 'key:KeyA:up']);
    expect(el.value).toBe('');
  });

  test('ASCII matching the physical key keeps the VK path (Shift, digits, punctuation, numpad, space)', () => {
    keydown({ code: 'KeyA', key: 'A', shiftKey: true });
    keydown({ code: 'Digit1', key: '!', shiftKey: true });
    keydown({ code: 'Semicolon', key: ';' });
    keydown({ code: 'Numpad5', key: '5' });
    keydown({ code: 'Space', key: ' ' });
    expect(log).toEqual(['key:KeyA:down', 'key:Digit1:down', 'key:Semicolon:down', 'key:Numpad5:down', 'key:Space:down']);
  });

  test('an ASCII character from another layout (AZERTY "a" on KeyQ) is sent as text', () => {
    const down = keydown({ code: 'KeyQ', key: 'a' });
    expect(down.defaultPrevented).toBe(true);
    expect(log).toEqual(['text:a']);
  });

  test('NumpadComma (ABNT2/JIS, no VK in the keymap) types "," as text exactly once', () => {
    const down = keydown({ code: 'NumpadComma', key: ',' });
    typeInput('insertText', ',');
    keyup({ code: 'NumpadComma', key: ',' });
    expect(down.defaultPrevented).toBe(true);
    expect(log.filter((l) => l.startsWith('text:'))).toEqual(['text:,']);
    expect(log).not.toContain('key:NumpadComma:down');
  });

  test('shortcuts stay on the VK path whatever character they produce', () => {
    keydown({ code: 'KeyC', key: 'с', ctrlKey: true }); // Russian layout Ctrl+C
    keydown({ code: 'KeyV', key: 'v', metaKey: true });
    keydown({ code: 'KeyF', key: 'f', altKey: true }); // Windows Alt+F
    keydown({ code: 'KeyA', key: 'ф', altKey: true }); // Alt-only never types on Windows
    expect(log).toEqual(['key:KeyC:down', 'key:KeyV:down', 'key:KeyF:down', 'key:KeyA:down']);
  });

  test('EVKey-style input method: Backspace keys then insertText replace the vowel', () => {
    keydown({ code: 'KeyA', key: 'a' });
    keyup({ code: 'KeyA', key: 'a' });
    keydown({ code: 'Backspace', key: 'Backspace' });
    keyup({ code: 'Backspace', key: 'Backspace' });
    typeInput('insertText', 'â');
    expect(log).toEqual(['key:KeyA:down', 'key:KeyA:up', 'key:Backspace:down', 'key:Backspace:up', 'text:â']);
    // Variant: the replacement arrives as a synthetic key event carrying the character.
    log = [];
    keydown({ code: 'Backspace', key: 'Backspace' });
    keyup({ code: 'Backspace', key: 'Backspace' });
    const down = keydown({ code: 'KeyA', key: 'ấ' });
    keyup({ code: 'KeyA', key: 'ấ' });
    expect(down.defaultPrevented).toBe(true);
    expect(log).toEqual(['key:Backspace:down', 'key:Backspace:up', 'text:ấ', 'key:KeyA:up']);
  });

  test('a non-ASCII character typed directly (international layout) is text with the default blocked', () => {
    const down = keydown({ code: 'Digit2', key: 'é' }); // French AZERTY
    if (!down.defaultPrevented) typeInput('insertText', 'é');
    expect(down.defaultPrevented).toBe(true);
    expect(log).toEqual(['text:é']);
  });

  test('macOS Option+e producing "é" without composition is text, not Alt+E', () => {
    attach({ optionTypesText: true });
    keydown({ code: 'AltLeft', key: 'Alt', altKey: true });
    const down = keydown({ code: 'KeyE', key: 'é', altKey: true });
    if (!down.defaultPrevented) typeInput('insertText', 'é');
    keyup({ code: 'KeyE', key: 'é', altKey: true });
    keyup({ code: 'AltLeft', key: 'Alt' });
    expect(down.defaultPrevented).toBe(true);
    expect(log).toEqual(['key:AltLeft:down', 'text:é', 'key:KeyE:up', 'key:AltLeft:up']);
  });

  test('Windows AltGr (Ctrl+Alt) characters are text, ASCII ones too when the key does not match', () => {
    keydown({ code: 'KeyE', key: '€', ctrlKey: true, altKey: true });
    keydown({ code: 'KeyQ', key: '@', ctrlKey: true, altKey: true }); // German layout
    expect(log).toEqual(['text:€', 'text:@']);
  });

  test('a dead key is never sent as a VK; the composed character arrives as text', () => {
    attach({ optionTypesText: true });
    keydown({ code: 'KeyE', key: 'Dead', altKey: true });
    composition('compositionstart', '');
    composition('compositionupdate', '´');
    keyup({ code: 'KeyE', key: 'Dead' });
    keydown({ code: 'KeyE', key: 'e', keyCode: 229, isComposing: true });
    composition('compositionend', 'é');
    expect(log.filter((l) => !l.endsWith(':up'))).toEqual(['text:é']);
  });

  test('text from a keydown passes the source event so held modifiers can be lifted first', () => {
    const sources: Array<KeyboardEvent | undefined> = [];
    detach();
    detach = attachTextInput(el, { key: () => {}, text: (_s, source) => sources.push(source) }, { optionTypesText: true });
    const down = keydown({ code: 'KeyP', key: 'π', altKey: true });
    typeInput('insertText', 'x');
    expect(sources).toEqual([down, undefined]);
  });

  test('detach removes the composition and beforeinput listeners too', () => {
    detach();
    typeInput('insertText', 'x');
    composition('compositionend', 'y');
    expect(log).toEqual([]);
  });
});
