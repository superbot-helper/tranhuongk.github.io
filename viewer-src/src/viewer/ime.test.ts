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
