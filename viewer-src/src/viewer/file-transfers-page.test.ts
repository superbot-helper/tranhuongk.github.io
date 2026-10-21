// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { peer, settle, TestSession } from './test-session';
import { mountViewer, type ViewerHandle } from './viewer';

vi.mock('../net/trust', () => ({ checkServerChain: vi.fn(), defaultAnchors: () => [] }));

describe('file transfer in the viewer page', () => {
  let session: TestSession;
  let app: HTMLElement;
  let viewer: ViewerHandle;
  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
  const cards = () => [...app.querySelectorAll<HTMLElement>('#chat-panel .file-card')];
  const status = (i = 0) => cards()[i]!.querySelector('.file-status')!.textContent;
  const file = (name: string, content = 'abc') => new File([content], name);

  function connect(tools = true): void {
    $<HTMLInputElement>('#token').value = 'x'.repeat(32);
    $<HTMLInputElement>('#partner').value = '123456789';
    $<HTMLInputElement>('#password').value = 'abc';
    $<HTMLFormElement>('#connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
    session.emit({ type: 'accepted', peer: peer() });
    if (tools) session.emit({ type: 'tools', available: true });
  }

  function drag(target: HTMLElement, type: string, files: File[] = [], types: string[] = ['Files']): Event {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
    target.dispatchEvent(e);
    return e;
  }

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = '<main id="app"></main>';
    app = document.getElementById('app')!;
    session = new TestSession();
    viewer = mountViewer(app, { createSession: () => session, workerUrl: 'ws://127.0.0.1:8787', schedule: (cb) => cb() });
  });

  afterEach(() => {
    viewer.destroy();
    vi.restoreAllMocks();
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  test('the paperclip is disabled until the tool gate opens, then picks several files and offers each', () => {
    const attach = $<HTMLButtonElement>('#chat-panel .chat-attach');
    const input = $<HTMLInputElement>('#chat-panel .chat-file');
    expect(attach.disabled).toBe(true);
    expect(input.multiple).toBe(true);
    connect();
    expect(attach.disabled).toBe(false);
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    attach.click();
    expect(click).toHaveBeenCalledTimes(1);
    Object.defineProperty(input, 'files', { value: [file('a.txt'), file('b.txt')], configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(session.offered.map((o) => o.name)).toEqual(['a.txt', 'b.txt']);
    expect(cards()).toHaveLength(2);
    expect(cards()[0]!.querySelector('.file-name')!.textContent).toBe('a.txt');
  });

  test('dropping files on the chat panel offers them', () => {
    connect();
    $<HTMLButtonElement>('#chat-toggle').click();
    const panel = $('#chat-panel');
    drag(panel, 'dragenter');
    expect(panel.querySelector<HTMLElement>('.drop-overlay')!.hidden).toBe(false);
    const e = drag(panel, 'drop', [file('x.bin')]);
    expect(e.defaultPrevented).toBe(true);
    expect(session.offered.map((o) => o.name)).toEqual(['x.bin']);
  });

  test('dropping files on the screen offers them, opens the chat and sends nothing to the remote', async () => {
    connect();
    await settle();
    const before = session.sent.length;
    const viewport = $('#viewport');
    drag(viewport, 'dragenter');
    expect($('#stage > .drop-overlay').hasAttribute('hidden')).toBe(false);
    const e = drag(viewport, 'drop', [file('shot.png')]);
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect($('#stage > .drop-overlay').hasAttribute('hidden')).toBe(true);
    expect(session.offered.map((o) => o.name)).toEqual(['shot.png']);
    expect($('#chat-panel').hidden).toBe(false);
    expect(session.sent.length).toBe(before);
    expect(session.commands).toEqual([]);
  });

  test('before the tool gate opens a dropped file is not offered', () => {
    connect(false);
    const e = drag($('#viewport'), 'drop', [file('x')]);
    expect(e.defaultPrevented).toBe(true);
    expect(session.offered).toEqual([]);
    expect(cards()).toHaveLength(0);
  });

  test('an incoming offer is an unread item for the Chat badge and cleared by opening the panel', () => {
    connect();
    const badge = $('#chat-toggle .badge');
    session.emit({ type: 'file', event: { type: 'incoming', id: 'r1', name: 'plan.pdf', size: 10 } });
    session.emit({ type: 'chat', text: 'hi' });
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('2');
    $<HTMLButtonElement>('#chat-toggle').click();
    expect(badge.hidden).toBe(true);
    expect(cards()[0]!.querySelector('.file-name')!.textContent).toBe('plan.pdf');
  });

  test('save in memory, then the download starts on the Tải về click', async () => {
    URL.createObjectURL = () => 'blob:x';
    URL.revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    connect();
    session.emit({ type: 'file', event: { type: 'incoming', id: 'r1', name: 'plan.pdf', size: 3 } });
    cards()[0]!.querySelector<HTMLButtonElement>('.file-save')!.click();
    await settle();
    const sink = session.accepted.get('r1')!;
    session.emit({ type: 'file', event: { type: 'progress', id: 'r1', bytes: 0, total: 3, direction: 'in' } });
    await sink.write(new Uint8Array([1, 2, 3]));
    await sink.close();
    session.emit({ type: 'file', event: { type: 'completed', id: 'r1' } });
    expect(click).not.toHaveBeenCalled();
    expect(status()).toBe('Xong — bấm Tải về để lưu');
    cards()[0]!.querySelector<HTMLButtonElement>('.file-download')!.click();
    expect(click).toHaveBeenCalledTimes(1);
    expect(status()).toBe('Đã tải về');
  });

  test('disconnecting turns running cards into "đã huỷ"; a new connection starts with no cards', async () => {
    connect();
    session.emit({ type: 'file', event: { type: 'incoming', id: 'r1', name: 'in.bin', size: 5 } });
    cards()[0]!.querySelector<HTMLButtonElement>('.file-save')!.click();
    await settle();
    session.emit({ type: 'file', event: { type: 'progress', id: 'r1', bytes: 2, total: 5, direction: 'in' } });
    session.sendFile('out.bin', { size: 1, read: async () => new Uint8Array(1) });
    drag($('#chat-panel'), 'drop', [file('out2.bin')]);
    const first = status(0);
    expect(first).toContain('%');
    session.close();
    expect(cards().map((c) => c.querySelector('.file-status')!.textContent)).toEqual(['Đã huỷ', 'Đã huỷ']);
    expect(cards().every((c) => c.querySelector<HTMLElement>('.file-cancel')!.hidden)).toBe(true);

    connect();
    expect(cards()).toHaveLength(0);
  });

  test('file names never reach the diagnostics log', () => {
    connect();
    session.emit({ type: 'file', event: { type: 'incoming', id: 'r1', name: 'bí-mật.docx', size: 5 } });
    drag($('#viewport'), 'drop', [file('riêng-tư.txt')]);
    session.emit({ type: 'file', event: { type: 'failed', id: 'r1', reason: 'The file could not be read or saved.' } });
    expect($('#log').textContent).not.toContain('bí-mật');
    expect($('#log').textContent).not.toContain('riêng-tư');
  });
});
