// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import html from '../../index.html?raw';
import { createToolbar, type Toolbar, type ToolbarHandlers } from './toolbar';

/** Accessible name as a screen reader computes it for these controls: aria-label, else the text content. */
const accessibleName = (el: Element) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();

describe('flat toolbar', () => {
  let root: HTMLDivElement;
  let toolbar: Toolbar;
  let handlers: ToolbarHandlers;

  beforeEach(() => {
    document.body.innerHTML = '<div id="toolbar"></div><div id="outside"></div>';
    root = document.querySelector('#toolbar')!;
    const noop = () => {};
    handlers = {
      control: vi.fn(), monitor: vi.fn(), scale: vi.fn(), quality: vi.fn(), wallpaper: vi.fn(), special: vi.fn(),
      chat: noop, clipboard: noop, capture: noop, record: noop, audio: vi.fn(), audioVolume: noop, fullscreen: noop,
      refresh: noop, disconnect: vi.fn(),
    };
    toolbar = createToolbar(root, handlers, { fullscreenSupported: true });
    toolbar.setState({ controlOn: true, controlAllowed: true, controlActive: true, keyboard: true });
    toolbar.setClipboard({ on: false, available: true });
    toolbar.setAudio({ on: false, available: true, volume: 1 });
  });

  afterEach(() => toolbar.dispose());

  test('Ngắt is the danger button and keeps its name', () => {
    const ngat = root.querySelector<HTMLButtonElement>('#toolbar-disconnect')!;
    expect(ngat.classList.contains('danger')).toBe(true);
    expect(accessibleName(ngat)).toBe('Ngắt');
    ngat.click();
    expect(handlers.disconnect).toHaveBeenCalledOnce();
  });

  test('every bar control has an accessible name and a tooltip when its label is visually hidden', () => {
    const controls = [...root.querySelectorAll<HTMLElement>('.tb-btn')];
    expect(controls.map((c) => c.id || c.parentElement!.id)).toEqual([
      'control-toggle', 'monitor-menu', 'display-menu', 'special-keys', 'capture-menu',
      'chat-toggle', 'clipboard-toggle', 'audio-menu', 'fullscreen', 'refresh', 'toolbar-disconnect',
    ]);
    for (const c of controls) {
      const id = c.id || c.parentElement!.id;
      // The name lives in a .label span (hidden visually, never with display:none) or aria-label.
      const label = c.querySelector('.label');
      expect(label, id).not.toBeNull();
      expect(label!.textContent!.length, id).toBeGreaterThan(0);
      expect(accessibleName(c).startsWith(label!.textContent!) || c.hasAttribute('aria-label'), id).toBe(true);
      expect(c.getAttribute('title'), id).toBeTruthy();
      // Icons are decorative and add no text.
      for (const svg of c.querySelectorAll('svg')) {
        expect(svg.getAttribute('aria-hidden'), id).toBe('true');
        expect(svg.textContent, id).toBe('');
      }
    }
    expect(accessibleName(root.querySelector('#control-toggle')!)).toBe('Điều khiển: bật');
    expect(accessibleName(root.querySelector('#clipboard-toggle')!)).toBe('Clipboard: tắt');
    expect(accessibleName(root.querySelector('#refresh')!)).toBe('Làm mới');
    expect(accessibleName(root.querySelector('#fullscreen')!)).toBe('Toàn màn hình');
    toolbar.setFullscreen(true);
    expect(accessibleName(root.querySelector('#fullscreen')!)).toBe('Thoát toàn màn hình');
    expect(root.querySelector('#fullscreen')!.getAttribute('title')).toBe('Thoát toàn màn hình');
  });

  test('labels are hidden with a clip (still read aloud), never display:none, below 900 px and when compact', () => {
    const narrow = /@media \(max-width: 899px\) \{([\s\S]*?)\n {6}\}/.exec(html)?.[1] ?? '';
    const rule = /\.toolbar \.label \{([^}]*)\}/.exec(narrow)?.[1] ?? '';
    expect(rule).toContain('clip-path: inset(50%)');
    expect(rule).not.toContain('display: none');
    const compact = /\.tb-btn\.icon-only \.label, \.toolbar\.compact \.label \{([^}]*)\}/.exec(html)?.[1] ?? '';
    expect(compact).toContain('clip-path: inset(50%)');
    expect(compact).not.toContain('display: none');
  });

  test('the loose selects live in menus with their ids and handlers', () => {
    expect(root.querySelector('#monitor-menu #monitor')).not.toBeNull();
    expect(root.querySelector('#display-menu #scale')).not.toBeNull();
    expect(root.querySelector('#display-menu #quality')).not.toBeNull();
    expect(root.querySelector('#display-menu #wallpaper')).not.toBeNull();
    expect(root.querySelector('#audio-menu #audio-toggle')).not.toBeNull();
    expect(root.querySelector('#audio-menu #audio-volume')).not.toBeNull();
    const quality = root.querySelector<HTMLSelectElement>('#quality')!;
    quality.value = 'speed';
    quality.dispatchEvent(new Event('change', { bubbles: true }));
    expect(handlers.quality).toHaveBeenCalledWith('speed');
    toolbar.setMonitors([{ index: 1, left: 0, top: 0, right: 10, bottom: 10 }, { index: 2, left: 10, top: 0, right: 20, bottom: 10 }], 2);
    const monitor = root.querySelector<HTMLSelectElement>('#monitor')!;
    expect(monitor.size).toBe(3);
    expect(monitor.value).toBe('2');
  });

  test('Âm thanh: the menu summary shows the on state; the switch keeps its name', () => {
    const menu = root.querySelector<HTMLDetailsElement>('#audio-menu')!;
    const toggle = root.querySelector<HTMLButtonElement>('#audio-toggle')!;
    expect(accessibleName(toggle)).toBe('Âm thanh: tắt');
    toggle.click();
    expect(handlers.audio).toHaveBeenCalledWith(true);
    toolbar.setAudio({ on: true, available: true, volume: 0.5 });
    expect(menu.classList.contains('on')).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(accessibleName(toggle)).toBe('Âm thanh: bật');
  });

  test('one menu open at a time; a pointer press outside closes it', async () => {
    const display = root.querySelector<HTMLDetailsElement>('#display-menu')!;
    const keys = root.querySelector<HTMLDetailsElement>('#special-keys')!;
    display.open = true;
    await new Promise((r) => setTimeout(r, 0)); // toggle events are async
    expect('placed' in display.querySelector<HTMLElement>('.menu-items')!.dataset).toBe(true);
    keys.open = true;
    await new Promise((r) => setTimeout(r, 0));
    expect(display.open).toBe(false);
    // Inside the menu: stays open.
    keys.querySelector('button')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(keys.open).toBe(true);
    document.querySelector('#outside')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(keys.open).toBe(false);
  });

  test('the recording clock stays visible on the Chụp summary', () => {
    toolbar.setCapture({ available: true, recording: true, seconds: 65 });
    const summary = root.querySelector('#capture-menu summary')!;
    expect(summary.textContent).toBe('Chụp ● 1:05');
    expect(summary.querySelector('.rec')!.textContent).toBe(' ● 1:05');
    expect(root.querySelector('#capture-menu')!.classList.contains('recording')).toBe(true);
  });
});
