// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CLIPBOARD_NOTICE_MS } from './clipboard-sync';
import { PASTE_FALLBACK_MS } from './input';
import { packet, peer, settle, TestSession } from './test-session';
import { mountViewer, type ViewerHandle } from './viewer';

vi.mock('../net/trust', () => ({ checkServerChain: vi.fn(), defaultAnchors: () => [] }));

const CTRL_DOWN = packet(1, 0xa2, 0x1d);
const CTRL_UP = packet(2, 0xa2, 0x1d);
const V_DOWN = packet(1, 0x56, 0x2f);
const V_UP = packet(2, 0x56, 0x2f);
const WIN_DOWN = packet(1, 0x5b, 0xe05b);
const WIN_UP = packet(2, 0x5b, 0xe05b);

describe('clipboard sync in the viewer page', () => {
  let session: TestSession;
  let app: HTMLElement;
  let viewer: ViewerHandle;
  let textarea: HTMLTextAreaElement;
  let writeText: ReturnType<typeof vi.fn>;
  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

  /** Apple platform: ⌘V is the local paste shortcut, Ctrl+V an ordinary remote shortcut. */
  function mountMac(): void {
    viewer.destroy();
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
    mount();
  }

  function mount(): void {
    document.body.innerHTML = '<main id="app"></main>';
    app = document.getElementById('app')!;
    session = new TestSession();
    viewer = mountViewer(app, { createSession: () => session, workerUrl: 'ws://127.0.0.1:8787', schedule: (cb) => cb() });
    textarea = $<HTMLTextAreaElement>('#keyboard-input');
  }

  function connect(): void {
    $<HTMLInputElement>('#token').value = 'x'.repeat(32);
    $<HTMLInputElement>('#partner').value = '123456789';
    $<HTMLInputElement>('#password').value = 'abc';
    $<HTMLFormElement>('#connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
    session.emit({ type: 'accepted', peer: peer() });
    session.emit({ type: 'tools', available: true });
  }

  const clipboardButton = () => $<HTMLButtonElement>('#clipboard-toggle');

  function paste(text: string): Event {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : '') } });
    textarea.dispatchEvent(e);
    return e;
  }

  function keyEvent(type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent {
    const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    textarea.dispatchEvent(e);
    return e;
  }

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    localStorage.clear();
    sessionStorage.clear();
    writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mount();
  });

  afterEach(() => {
    viewer.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (navigator as unknown as Record<string, unknown>).clipboard;
    delete (navigator as unknown as Record<string, unknown>).platform;
  });

  test('Clipboard is off by default; turning it on enables sharing on the session', () => {
    connect();
    expect(clipboardButton().getAttribute('aria-pressed')).toBe('false');
    expect(session.sharing).toEqual([]);
    clipboardButton().click();
    expect(clipboardButton().getAttribute('aria-pressed')).toBe('true');
    expect(session.sharing).toEqual([true]);
    expect(session.clipboardAllowed).toBe(true);
    clipboardButton().click();
    expect(session.sharing).toEqual([true, false]);
  });

  test('paste with Clipboard on sends the text, then Ctrl down, V down, V up, Ctrl up', async () => {
    connect();
    clipboardButton().click();
    const e = paste('xin chào');
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(session.sent).toEqual(['clipboard xin chào', CTRL_DOWN, V_DOWN, V_UP, CTRL_UP]);
    // The history tab records it.
    expect([...app.querySelectorAll('#chat-panel .clip-text')].map((x) => x.textContent)).toEqual(['xin chào']);
  });

  test('paste with Clipboard off sends only Ctrl+V', async () => {
    connect();
    paste('bí mật');
    await settle();
    expect(session.sent).toEqual([CTRL_DOWN, V_DOWN, V_UP, CTRL_UP]);
    expect(app.querySelectorAll('#chat-panel .clip-entry')).toHaveLength(0);
  });

  test('Mac ⌘V + paste: the V keydown is not sent (no Win+V); upload, then Ctrl+V once with Win lifted under Ctrl', async () => {
    mountMac();
    connect();
    clipboardButton().click();
    vi.useFakeTimers();
    keyEvent('keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true });
    const v = keyEvent('keydown', { code: 'KeyV', key: 'v', metaKey: true });
    // The browser default must run: it is what fires `paste`.
    expect(v.defaultPrevented).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sent).toEqual([WIN_DOWN]);
    paste('abc');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sent).toEqual([WIN_DOWN, 'clipboard abc', CTRL_DOWN, WIN_UP, V_DOWN, V_UP, CTRL_UP]);
    // The fallback was cancelled; V and ⌘ released afterwards: nothing more goes out.
    await vi.advanceTimersByTimeAsync(PASTE_FALLBACK_MS * 3);
    keyEvent('keyup', { code: 'KeyV', key: 'v', metaKey: true });
    keyEvent('keyup', { code: 'MetaLeft', key: 'Meta' });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sent).toHaveLength(7);
    // A plain V afterwards is typed normally.
    keyEvent('keydown', { code: 'KeyV', key: 'v' });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sent.at(-1)).toEqual(packet(1, 0x56, 0x2f, 0x76));
  });

  test('Mac ⌘V without a paste event: Ctrl+V after 150 ms, never a lone Win', async () => {
    mountMac();
    connect();
    clipboardButton().click();
    vi.useFakeTimers();
    keyEvent('keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true });
    keyEvent('keydown', { code: 'KeyV', key: 'v', metaKey: true });
    await vi.advanceTimersByTimeAsync(PASTE_FALLBACK_MS - 1);
    expect(session.sent).toEqual([WIN_DOWN]);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.sent).toEqual([WIN_DOWN, CTRL_DOWN, WIN_UP, V_DOWN, V_UP, CTRL_UP]);
    keyEvent('keyup', { code: 'KeyV', key: 'v', metaKey: true });
    keyEvent('keyup', { code: 'MetaLeft', key: 'Meta' });
    await vi.advanceTimersByTimeAsync(PASTE_FALLBACK_MS * 3);
    expect(session.sent).toEqual([WIN_DOWN, CTRL_DOWN, WIN_UP, V_DOWN, V_UP, CTRL_UP]);
  });

  test('Mac ⌘ released before the fallback fires: Ctrl+V goes first, Win is not lifted alone', async () => {
    mountMac();
    connect();
    vi.useFakeTimers();
    keyEvent('keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true });
    keyEvent('keydown', { code: 'KeyV', key: 'v', metaKey: true });
    await vi.advanceTimersByTimeAsync(20);
    keyEvent('keyup', { code: 'MetaLeft', key: 'Meta' });
    await vi.advanceTimersByTimeAsync(PASTE_FALLBACK_MS * 3);
    expect(session.sent).toEqual([WIN_DOWN, CTRL_DOWN, WIN_UP, V_DOWN, V_UP, CTRL_UP]);
    // A paste event arriving late (after the fallback typed Ctrl+V) does not paste twice.
    paste('');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sent).toHaveLength(6);
  });

  test('Mac Ctrl+V is an ordinary remote shortcut on the VK path', async () => {
    mountMac();
    connect();
    vi.useFakeTimers();
    keyEvent('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
    const v = keyEvent('keydown', { code: 'KeyV', key: 'v', ctrlKey: true });
    keyEvent('keyup', { code: 'KeyV', key: 'v', ctrlKey: true });
    keyEvent('keyup', { code: 'ControlLeft', key: 'Control' });
    await vi.advanceTimersByTimeAsync(PASTE_FALLBACK_MS * 3);
    expect(v.defaultPrevented).toBe(true);
    expect(session.sent).toEqual([CTRL_DOWN, V_DOWN, V_UP, CTRL_UP]);
  });

  test('non-Mac Ctrl+V is intercepted: Ctrl held by the user stays held; only V goes down and up', async () => {
    connect();
    keyEvent('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
    const v = keyEvent('keydown', { code: 'KeyV', key: 'v', ctrlKey: true });
    expect(v.defaultPrevented).toBe(false);
    await settle();
    expect(session.sent).toEqual([CTRL_DOWN]);
    paste('abc');
    await settle();
    expect(session.sent).toEqual([CTRL_DOWN, V_DOWN, V_UP]);
    keyEvent('keyup', { code: 'KeyV', key: 'v', ctrlKey: true });
    keyEvent('keyup', { code: 'ControlLeft', key: 'Control' });
    await new Promise((r) => setTimeout(r, PASTE_FALLBACK_MS + 50));
    // The fallback was cancelled by the paste event: no second Ctrl+V.
    expect(session.sent).toEqual([CTRL_DOWN, V_DOWN, V_UP, CTRL_UP]);
  });

  test('a failed upload sends only the upload attempt, no Ctrl+V', async () => {
    connect();
    clipboardButton().click();
    session.failClipboard = new Error('sendFailed');
    paste('không gửi được');
    await settle();
    expect(session.sent).toEqual(['clipboard không gửi được']);
    expect($('#clipboard-toast').textContent).toContain('Không gửi được clipboard');
  });

  test('paste while not controlling sends nothing and inserts nothing', async () => {
    connect();
    clipboardButton().click();
    $<HTMLButtonElement>('#control-toggle').click();
    const e = paste('abc');
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(session.sent).toEqual([]);
  });

  test('Windows copy with Clipboard on: writeText gets the text and the history records it', async () => {
    connect();
    clipboardButton().click();
    session.emit({ type: 'clipboard', text: 'từ Windows' });
    await settle();
    expect(writeText).toHaveBeenCalledWith('từ Windows');
    expect([...app.querySelectorAll('#chat-panel .clip-entry .clip-meta')].map((x) => x.textContent)[0]).toContain('Từ máy Windows');
    expect($('#clipboard-toast .toast-copy').hidden).toBe(true);
  });

  test('writeText rejected: a toast offers Sao chép, which copies inside the click; it stays until used or dismissed', async () => {
    connect();
    clipboardButton().click();
    writeText.mockRejectedValueOnce(new DOMException('no gesture', 'NotAllowedError'));
    session.emit({ type: 'clipboard', text: 'mã 1234' });
    await settle();
    const toast = $('#clipboard-toast');
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain('Máy Windows vừa copy văn bản');
    const copy = $<HTMLButtonElement>('#clipboard-toast .toast-copy');
    expect(copy.hidden).toBe(false);
    expect(copy.textContent).toBe('Sao chép');
    copy.click();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith('mã 1234');
    await settle();
    expect(copy.hidden).toBe(true);

    vi.useFakeTimers();
    writeText.mockRejectedValueOnce(new DOMException('no gesture', 'NotAllowedError'));
    session.emit({ type: 'clipboard', text: 'mã 5678' });
    await vi.advanceTimersByTimeAsync(0);
    expect(toast.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(CLIPBOARD_NOTICE_MS * 10);
    expect(toast.hidden).toBe(false);
    expect(copy.hidden).toBe(false);
    $<HTMLButtonElement>('#clipboard-toast .toast-close').click();
    expect(toast.hidden).toBe(true);
    // Plain notices still fade after 3 s.
    session.emit({ type: 'clipboard', text: 'mã 9999' });
    await vi.advanceTimersByTimeAsync(0);
    expect(toast.hidden).toBe(false);
    expect(copy.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(CLIPBOARD_NOTICE_MS);
    expect(toast.hidden).toBe(true);
  });

  test('no clipboard API at all: the toast with the button appears too', async () => {
    delete (navigator as unknown as Record<string, unknown>).clipboard;
    connect();
    clipboardButton().click();
    session.emit({ type: 'clipboard', text: 'x' });
    await settle();
    expect($('#clipboard-toast').hidden).toBe(false);
    expect($<HTMLButtonElement>('#clipboard-toast .toast-copy').hidden).toBe(false);
  });

  test('no echo: text received from Windows is not uploaded back, and a repeat is not rewritten', async () => {
    connect();
    clipboardButton().click();
    session.emit({ type: 'clipboard', text: 'vòng' });
    await settle();
    paste('vòng');
    await settle();
    expect(session.sent).toEqual([CTRL_DOWN, V_DOWN, V_UP, CTRL_UP]);
    session.emit({ type: 'clipboard', text: 'vòng' });
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    // What we sent is not written back when Windows echoes it.
    paste('đi');
    await settle();
    session.emit({ type: 'clipboard', text: 'đi' });
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(app.querySelectorAll('#chat-panel .clip-entry')).toHaveLength(2);
  });

  test('a clipboard event while sharing is off is ignored', async () => {
    connect();
    session.emit({ type: 'clipboard', text: 'x' });
    await settle();
    expect(writeText).not.toHaveBeenCalled();
  });

  test('history keeps the 20 newest entries', async () => {
    connect();
    clipboardButton().click();
    for (let i = 0; i < 25; i++) session.emit({ type: 'clipboard', text: `t${i}` });
    await settle();
    const texts = [...app.querySelectorAll('#chat-panel .clip-text')].map((x) => x.textContent);
    expect(texts).toHaveLength(20);
    expect(texts[0]).toBe('t24');
    expect(texts[19]).toBe('t5');
  });

  test('tools unavailable: the Clipboard button is disabled with a reason', () => {
    $<HTMLInputElement>('#token').value = 'x'.repeat(32);
    $<HTMLInputElement>('#partner').value = '123456789';
    $<HTMLInputElement>('#password').value = 'abc';
    $<HTMLFormElement>('#connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
    session.emit({ type: 'accepted', peer: peer() });
    expect(clipboardButton().disabled).toBe(true);
    expect(clipboardButton().title).not.toBe('');
    session.emit({ type: 'tools', available: true });
    expect(clipboardButton().disabled).toBe(false);
  });

  test('the choice is remembered on the device only with "Nhớ trên thiết bị này"', () => {
    connect();
    clipboardButton().click();
    expect(localStorage.getItem('uvweb.clipboard')).toBeNull();
    session.close();
    viewer.destroy();

    mount();
    const remember = $<HTMLInputElement>('#remember');
    remember.checked = true;
    remember.dispatchEvent(new Event('change'));
    connect();
    expect(session.sharing).toEqual([]);
    clipboardButton().click();
    expect(localStorage.getItem('uvweb.clipboard')).toBe('1');
    session.close();
    viewer.destroy();

    mount();
    connect();
    expect(clipboardButton().getAttribute('aria-pressed')).toBe('true');
    expect(session.sharing).toEqual([true]);
    // Unchecking "remember" forgets it.
    const again = $<HTMLInputElement>('#remember');
    again.checked = false;
    again.dispatchEvent(new Event('change'));
    expect(localStorage.getItem('uvweb.clipboard')).toBeNull();
  });

  test('clipboard text never reaches the diagnostics log', async () => {
    connect();
    clipboardButton().click();
    paste('mật-khẩu-123');
    session.emit({ type: 'clipboard', text: 'bí-mật-456' });
    await settle();
    const log = $('#log').textContent ?? '';
    expect(log).not.toContain('mật-khẩu-123');
    expect(log).not.toContain('bí-mật-456');
  });

  describe('"Dán sang Windows" (phones: no paste shortcut)', () => {
    let readText: ReturnType<typeof vi.fn>;
    const useReadText = (impl: () => Promise<string>) => {
      readText = vi.fn(impl);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } });
    };
    const touchPaste = () => $<HTMLButtonElement>('[data-touch="paste"]');
    const toastText = () => $('#clipboard-toast .toast-text').textContent;
    const keyboardOnly = [CTRL_DOWN, V_DOWN, V_UP, CTRL_UP];

    test('the floating Dán button reads the device clipboard inside the click, uploads it, then types Ctrl+V', async () => {
      useReadText(async () => 'từ điện thoại');
      connect();
      clipboardButton().click();
      touchPaste().click();
      expect(readText).toHaveBeenCalledTimes(1); // synchronously inside the click
      await settle();
      expect(session.sent).toEqual(['clipboard từ điện thoại', ...keyboardOnly]);
      expect([...app.querySelectorAll('#chat-panel .clip-text')].map((x) => x.textContent)).toEqual(['từ điện thoại']);
    });

    test('the Clipboard-tab button does the same', async () => {
      useReadText(async () => 'abc');
      connect();
      clipboardButton().click();
      $<HTMLButtonElement>('#chat-panel .clip-paste').click();
      await settle();
      expect(session.sent).toEqual(['clipboard abc', ...keyboardOnly]);
    });

    test('the same text again is not uploaded twice (echo rule) but Ctrl+V is still typed', async () => {
      useReadText(async () => 'abc');
      connect();
      clipboardButton().click();
      touchPaste().click();
      await settle();
      touchPaste().click();
      await settle();
      expect(session.sent).toEqual(['clipboard abc', ...keyboardOnly, ...keyboardOnly]);
    });

    test('text that just came from Windows is not bounced back', async () => {
      useReadText(async () => 'từ windows');
      connect();
      clipboardButton().click();
      session.emit({ type: 'clipboard', text: 'từ windows' });
      touchPaste().click();
      await settle();
      expect(session.sent).toEqual(keyboardOnly);
    });

    test('with Clipboard sharing off: a toast asks to turn it on, nothing is read or sent', async () => {
      useReadText(async () => 'abc');
      connect();
      touchPaste().click();
      await settle();
      expect(readText).not.toHaveBeenCalled();
      expect(session.sent).toEqual([]);
      expect($<HTMLElement>('#clipboard-toast').hidden).toBe(false);
      expect(toastText()).toContain('Bật Clipboard');
    });

    test('readText rejected: Vietnamese toast explaining the block, nothing sent', async () => {
      useReadText(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
      connect();
      clipboardButton().click();
      touchPaste().click();
      await settle();
      expect(session.sent).toEqual([]);
      expect(toastText()).toContain('Trình duyệt không cho đọc clipboard');
      expect($('#log').textContent).toContain('Đọc clipboard bị trình duyệt từ chối');
    });

    test('no Clipboard API at all behaves like a refusal', async () => {
      delete (navigator as unknown as Record<string, unknown>).clipboard;
      connect();
      clipboardButton().click();
      touchPaste().click();
      await settle();
      expect(session.sent).toEqual([]);
      expect(toastText()).toContain('Trình duyệt không cho đọc clipboard');
    });

    test('an empty device clipboard pastes nothing', async () => {
      useReadText(async () => '');
      connect();
      clipboardButton().click();
      touchPaste().click();
      await settle();
      expect(session.sent).toEqual([]);
      expect(toastText()).toContain('trống');
    });

    test('with Điều khiển off nothing is read; a toast says to turn it on', async () => {
      useReadText(async () => 'abc');
      connect();
      clipboardButton().click();
      $<HTMLButtonElement>('#control-toggle').click(); // local control off
      touchPaste().click();
      await settle();
      expect(readText).not.toHaveBeenCalled();
      expect(session.sent).toEqual([]);
      expect(toastText()).toContain('Bật Điều khiển');
    });

    test('a session that ended during the read gets no Ctrl+V', async () => {
      let resolve!: (t: string) => void;
      useReadText(() => new Promise<string>((r) => (resolve = r)));
      connect();
      clipboardButton().click();
      touchPaste().click();
      const before = session.sent.length;
      session.close();
      resolve('abc');
      await settle();
      expect(session.sent.slice(before)).toEqual([]);
    });

    test('the text never reaches the diagnostics log', async () => {
      useReadText(async () => 'mật-khẩu-riêng-789');
      connect();
      clipboardButton().click();
      touchPaste().click();
      await settle();
      expect($('#log').textContent).not.toContain('mật-khẩu-riêng-789');
    });
  });
});
