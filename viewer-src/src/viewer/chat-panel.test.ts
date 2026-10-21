// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatError } from '../proto/chat';
import {
  createChatPanel,
  MAX_TRANSCRIPT_MESSAGES,
  PEER_TYPING_MS,
  TYPING_DEBOUNCE_MS,
  TYPING_IDLE_MS,
  type ChatPanel,
  type ChatPanelHandlers,
} from './chat-panel';
import { packet, peer, settle, TestSession } from './test-session';
import { mountViewer, type ViewerHandle } from './viewer';

vi.mock('../net/trust', () => ({ checkServerChain: vi.fn(), defaultAnchors: () => [] }));

describe('chat panel', () => {
  let root: HTMLElement;
  let panel: ChatPanel;
  let sent: string[];
  let typing: boolean[];
  let changes: Array<{ open: boolean; unread: number }>;
  let closed: number;
  let failSend: Error | null;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const input = () => $<HTMLTextAreaElement>('.chat-input');

  function type(text: string): void {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  }

  function enter(init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...init });
    input().dispatchEvent(e);
    return e;
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="chat"></div>';
    root = document.getElementById('chat')!;
    sent = [];
    typing = [];
    changes = [];
    closed = 0;
    failSend = null;
    const handlers: ChatPanelHandlers = {
      send: async (text) => {
        if (failSend) throw failSend;
        sent.push(text);
      },
      typing: async (t) => {
        typing.push(t);
      },
      copy: () => {},
      changed: (s) => changes.push(s),
      closed: () => closed++,
    };
    panel = createChatPanel(root, handlers);
    panel.setAvailable(true);
  });

  afterEach(() => {
    panel.dispose();
    vi.useRealTimers();
  });

  test('Enter sends the draft, Shift+Enter and an IME Enter do not', async () => {
    panel.open();
    type('xin chào');
    expect(enter({ shiftKey: true }).defaultPrevented).toBe(false);
    expect(enter({ isComposing: true }).defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
    expect(enter().defaultPrevented).toBe(true);
    await settle();
    expect(sent).toEqual(['xin chào']);
    expect(input().value).toBe('');
    const items = [...root.querySelectorAll('.chat-message')];
    expect(items).toHaveLength(1);
    expect(items[0]!.classList.contains('outgoing')).toBe(true);
    expect(items[0]!.querySelector('.chat-text')!.textContent).toBe('xin chào');
    expect(items[0]!.querySelector('.chat-meta')!.textContent).toMatch(/^Bạn · \d{2}:\d{2}$/);
  });

  test('a blank draft is not sent; an over-long one is refused with a message', async () => {
    type('   \n ');
    enter();
    await settle();
    expect(sent).toEqual([]);
    type('a'.repeat(16_385));
    enter();
    await settle();
    expect(sent).toEqual([]);
    expect($('.chat-error').textContent).toContain('16.384');
    expect($('.chat-error').hidden).toBe(false);
  });

  test('a ChatError from the session is shown in Vietnamese and the draft is kept', async () => {
    failSend = new ChatError('unsupportedDelimiter');
    type('a|||b');
    enter();
    await settle();
    expect($('.chat-error').textContent).toContain('|||');
    expect(input().value).toBe('a|||b');
    expect(root.querySelectorAll('.chat-message')).toHaveLength(0);
  });

  test('typing: debounced 0.25 s, true then false after 2 s idle; an emptied draft sends false', async () => {
    vi.useFakeTimers();
    type('x');
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE_MS - 1);
    type('xy');
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE_MS - 1);
    expect(typing).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(typing).toEqual([true]);
    await vi.advanceTimersByTimeAsync(TYPING_IDLE_MS - 1);
    expect(typing).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1);
    expect(typing).toEqual([true, false]);
    type('xyz');
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE_MS);
    type('');
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE_MS);
    expect(typing).toEqual([true, false, true, false]);
    await vi.advanceTimersByTimeAsync(TYPING_IDLE_MS * 2);
    expect(typing).toEqual([true, false, true, false]);
  });

  test('the peer typing indicator shows and expires after 4 s; a message clears it', async () => {
    vi.useFakeTimers();
    const indicator = $('.chat-typing');
    expect(indicator.hidden).toBe(true);
    panel.setPeerTyping(true);
    expect(indicator.hidden).toBe(false);
    expect(indicator.textContent).toContain('đang gõ');
    await vi.advanceTimersByTimeAsync(PEER_TYPING_MS - 1);
    expect(indicator.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(indicator.hidden).toBe(true);
    panel.setPeerTyping(true);
    panel.receive('xong');
    expect(indicator.hidden).toBe(true);
    panel.setPeerTyping(true);
    panel.setPeerTyping(false);
    expect(indicator.hidden).toBe(true);
  });

  test('incoming messages while closed count as unread; opening clears the count', () => {
    panel.receive('một');
    panel.receive('hai');
    expect(changes.at(-1)).toEqual({ open: false, unread: 2 });
    panel.open();
    expect(changes.at(-1)).toEqual({ open: true, unread: 0 });
    panel.receive('ba');
    expect(changes.at(-1)).toEqual({ open: true, unread: 0 });
    const last = [...root.querySelectorAll('.chat-message')].at(-1)!;
    expect(last.classList.contains('incoming')).toBe(true);
    expect(last.querySelector('.chat-meta')!.textContent).toMatch(/^Máy Windows · /);
  });

  test('the transcript keeps the newest 200 messages', () => {
    for (let i = 0; i < MAX_TRANSCRIPT_MESSAGES + 5; i++) panel.receive(`m${i}`);
    const items = [...root.querySelectorAll('.chat-text')].map((e) => e.textContent);
    expect(items).toHaveLength(MAX_TRANSCRIPT_MESSAGES);
    expect(items[0]).toBe('m5');
  });

  test('the transcript keeps at most 1 MiB of text', () => {
    const big = 'a'.repeat(16_000);
    for (let i = 0; i < 70; i++) panel.receive(big + i);
    const total = [...root.querySelectorAll('.chat-text')].reduce((n, e) => n + e.textContent!.length, 0);
    expect(total).toBeLessThanOrEqual(1_048_576);
    expect(root.querySelectorAll('.chat-text').length).toBe(65);
  });

  test('unavailable tools disable the input with a reason and stop typing reports', async () => {
    vi.useFakeTimers();
    type('x');
    panel.setAvailable(false, 'Chưa kết nối xong.');
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE_MS * 10);
    expect(typing).toEqual([]);
    expect(input().disabled).toBe(true);
    expect($<HTMLButtonElement>('.chat-send').disabled).toBe(true);
    expect($('.chat-unavailable').textContent).toBe('Chưa kết nối xong.');
    expect($('.chat-unavailable').hidden).toBe(false);
  });

  test('Escape and the close button close the panel and report it', () => {
    panel.open();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    expect(panel.isOpen).toBe(false);
    expect(closed).toBe(1);
    panel.open();
    $<HTMLButtonElement>('.chat-close').click();
    expect(panel.isOpen).toBe(false);
    expect(closed).toBe(2);
  });

  test('the Clipboard tab lists history entries with a copy button', () => {
    const copied: string[] = [];
    panel.dispose();
    root.innerHTML = '';
    panel = createChatPanel(root, {
      send: async () => {}, typing: async () => {}, changed: () => {}, closed: () => {},
      copy: (t) => copied.push(t),
    });
    panel.setClipboardHistory([
      { text: 'mới', outgoing: false, at: new Date() },
      { text: 'cũ', outgoing: true, at: new Date() },
    ]);
    panel.open('clipboard');
    expect($('.chat-pane-clipboard').hidden).toBe(false);
    expect($('.chat-pane-chat').hidden).toBe(true);
    const entries = [...root.querySelectorAll('.clip-entry')];
    expect(entries.map((e) => e.querySelector('.clip-text')!.textContent)).toEqual(['mới', 'cũ']);
    expect(entries[0]!.querySelector('.clip-meta')!.textContent).toContain('Từ máy Windows');
    expect(entries[1]!.querySelector('.clip-meta')!.textContent).toContain('Gửi đi');
    entries[1]!.querySelector<HTMLButtonElement>('.clip-copy')!.click();
    expect(copied).toEqual(['cũ']);
  });
});

describe('chat in the viewer page', () => {
  let session: TestSession;
  let app: HTMLElement;
  let viewer: ViewerHandle;
  let textarea: HTMLTextAreaElement;
  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

  function connect(): void {
    $<HTMLInputElement>('#token').value = 'x'.repeat(32);
    $<HTMLInputElement>('#partner').value = '123456789';
    $<HTMLInputElement>('#password').value = 'abc';
    $<HTMLFormElement>('#connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
    session.emit({ type: 'accepted', peer: peer() });
    session.emit({ type: 'tools', available: true });
  }

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = '<main id="app"></main>';
    app = document.getElementById('app')!;
    session = new TestSession();
    viewer = mountViewer(app, { createSession: () => session, workerUrl: 'ws://127.0.0.1:8787', schedule: (cb) => cb() });
    textarea = $<HTMLTextAreaElement>('#keyboard-input');
  });

  afterEach(() => {
    viewer.destroy();
    vi.restoreAllMocks();
  });

  test('the Chat button opens the panel; Enter sends through sendChat; keys never reach Windows', async () => {
    connect();
    const button = $<HTMLButtonElement>('#chat-toggle');
    button.click();
    const panelEl = $('#chat-panel');
    expect(panelEl.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const input = $<HTMLTextAreaElement>('#chat-panel .chat-input');
    expect(document.activeElement).toBe(input);
    await settle();
    const n = session.sent.length;
    input.value = 'chào';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (const type of ['keydown', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }));
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(session.chats).toEqual(['chào']);
    // Only what the hidden textarea's blur released (nothing held): no key packets at all.
    expect(session.sent.slice(n)).toEqual([]);
  });

  test('closing the panel hands the keyboard back to the remote screen', () => {
    connect();
    $<HTMLButtonElement>('#chat-toggle').click();
    expect(document.activeElement).not.toBe(textarea);
    $<HTMLButtonElement>('#chat-panel .chat-close').click();
    expect($('#chat-panel').hidden).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  test('a message while the panel is closed shows an unread badge on the Chat button', () => {
    connect();
    const badge = $('#chat-toggle .badge');
    expect(badge.hidden).toBe(true);
    session.emit({ type: 'chat', text: 'xin chào' });
    session.emit({ type: 'chat', text: 'bạn ơi' });
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('2');
    $<HTMLButtonElement>('#chat-toggle').click();
    expect(badge.hidden).toBe(true);
    expect([...app.querySelectorAll('#chat-panel .chat-text')].map((e) => e.textContent)).toEqual(['xin chào', 'bạn ơi']);
  });

  test('typing events drive the indicator', () => {
    connect();
    session.emit({ type: 'typing', typing: true });
    expect($('#chat-panel .chat-typing').hidden).toBe(false);
    session.emit({ type: 'typing', typing: false });
    expect($('#chat-panel .chat-typing').hidden).toBe(true);
  });

  test('before tools are available the chat input is disabled with a reason', () => {
    $<HTMLInputElement>('#token').value = 'x'.repeat(32);
    $<HTMLInputElement>('#partner').value = '123456789';
    $<HTMLInputElement>('#password').value = 'abc';
    $<HTMLFormElement>('#connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
    session.emit({ type: 'accepted', peer: peer() });
    expect($<HTMLTextAreaElement>('#chat-panel .chat-input').disabled).toBe(true);
    expect($('#chat-panel .chat-unavailable').textContent).not.toBe('');
    session.emit({ type: 'tools', available: true });
    expect($<HTMLTextAreaElement>('#chat-panel .chat-input').disabled).toBe(false);
  });

  test('the session end clears the transcript and closes the panel', () => {
    connect();
    session.emit({ type: 'chat', text: 'bí mật' });
    $<HTMLButtonElement>('#chat-toggle').click();
    session.close();
    expect($('#chat-panel').hidden).toBe(true);
    expect(app.querySelectorAll('#chat-panel .chat-message')).toHaveLength(0);
    // Chat content never reaches the diagnostics log.
    expect($('#log').textContent).not.toContain('bí mật');
  });

  test('typing in the hidden textarea still goes to Windows while the panel is closed', async () => {
    connect();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }));
    await settle();
    expect(session.sent.at(-1)).toEqual(packet(1, 0x41, 0x1e, 0x61));
  });
});
