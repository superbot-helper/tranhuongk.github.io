// Chat panel, after MacViewer's SessionToolsModel (sendDraft, receiveChat, receiveTyping,
// draftChanged, transcript bounds) and SessionToolsView: a floating panel (desktop: right side of
// the stage; coarse pointer: bottom sheet, see index.html) with a Chat tab (transcript, typing
// indicator, input: Enter sends, Shift+Enter is a new line) and a Clipboard tab (the session's
// clipboard history with a copy button per entry). Messages arriving while it is closed count as
// unread for the toolbar badge. Its input is an ordinary textarea outside the remote screen, so
// nothing typed here is routed to Windows. Content is rendered with textContent only, never logged.
import { ChatError } from '../proto/chat';
import type { ClipboardEntry } from './clipboard-sync';
import { attachDropZone } from './file-transfers';

/** UI limit of a chat message (Swift 16,384 UTF-16 units). */
export const MAX_CHAT_UNITS = 16_384;
export const TYPING_DEBOUNCE_MS = 250;
/** After "typing" was sent, "not typing" follows this long after the last change. */
export const TYPING_IDLE_MS = 2_000;
/** The peer's "typing" indicator expires this long after the last report. */
export const PEER_TYPING_MS = 4_000;
export const MAX_TRANSCRIPT_MESSAGES = 200;
export const MAX_TRANSCRIPT_BYTES = 1_048_576;
/** Characters of a clipboard entry shown in the history (the copy button copies all of it). */
const CLIP_PREVIEW_UNITS = 2_000;

export type ChatTab = 'chat' | 'clipboard';

export interface ChatPanelHandlers {
  /** session.sendChat (rejects with ChatError / RelaySessionError). */
  send(text: string): Promise<void>;
  /** session.sendTyping. */
  typing(typing: boolean): Promise<void>;
  /** Files chosen with the 📎 button or dropped on the panel: offer them to the Windows machine. */
  attach(files: File[]): void;
  /** Copy a clipboard-history entry to this device (called inside the click). */
  copy(text: string): void;
  /** Open state or unread count changed (toolbar button and badge). */
  changed(state: { open: boolean; unread: number }): void;
  /** The user closed the panel: the keyboard goes back to the remote screen. */
  closed(): void;
}

export interface ChatPanel {
  readonly isOpen: boolean;
  /** Show the panel (unread cleared); `focus` puts the caret in the chat input. */
  open(tab?: ChatTab, focus?: boolean): void;
  /** Hide it (as the user would: `closed` is reported). */
  close(): void;
  setAvailable(available: boolean, reason?: string): void;
  receive(text: string): void;
  /** Put a file card in the transcript; an incoming offer counts as unread while the panel is closed. */
  addCard(card: HTMLElement, incoming: boolean): void;
  setPeerTyping(typing: boolean): void;
  setClipboardHistory(entries: readonly ClipboardEntry[]): void;
  /** Session ended: hidden (without `closed`), transcript, draft, unread and typing state cleared. */
  reset(): void;
  dispose(): void;
}

interface Message {
  el: HTMLElement;
  bytes: number;
}

const utf8 = new TextEncoder();

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function chatErrorText(e: unknown): string {
  if (e instanceof ChatError) {
    switch (e.code) {
      case 'unsupportedDelimiter':
        return 'Tin nhắn không được chứa "|||".';
      case 'invalidText':
      case 'invalidEncoding':
        return 'Tin nhắn có ký tự không gửi được.';
      case 'textTooLarge':
        return 'Tin nhắn quá dài (tối đa 32 KiB).';
      default:
        break;
    }
  }
  return 'Không gửi được tin nhắn.';
}

export function createChatPanel(root: HTMLElement, h: ChatPanelHandlers): ChatPanel {
  root.classList.add('chat-panel');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Chat với máy Windows');
  root.hidden = true;
  root.innerHTML = `
    <div class="chat-head">
      <div class="chat-tabs" role="tablist">
        <button type="button" role="tab" class="chat-tab" data-tab="chat" aria-selected="true">Chat</button>
        <button type="button" role="tab" class="chat-tab" data-tab="clipboard" aria-selected="false">Clipboard</button>
      </div>
      <button type="button" class="chat-close" aria-label="Đóng chat">×</button>
    </div>
    <div class="chat-pane chat-pane-chat" role="tabpanel">
      <ol class="chat-transcript" aria-live="polite"></ol>
      <p class="chat-typing" hidden>Máy Windows đang gõ…</p>
      <p class="chat-unavailable" hidden></p>
      <p class="chat-error" role="alert" hidden></p>
      <div class="chat-compose">
        <button type="button" class="chat-attach" aria-label="Gửi file sang máy Windows" title="Gửi file (hoặc kéo file thả vào đây)">📎</button>
        <input type="file" class="chat-file" multiple hidden tabindex="-1" />
        <textarea class="chat-input" rows="2" maxlength="${MAX_CHAT_UNITS}" placeholder="Nhập tin nhắn (Enter gửi, Shift+Enter xuống dòng)"
          aria-label="Tin nhắn chat" autocomplete="off"></textarea>
        <button type="button" class="chat-send">Gửi</button>
      </div>
    </div>
    <div class="chat-pane chat-pane-clipboard" role="tabpanel" hidden>
      <p class="clip-empty">Chưa có gì. Bật Clipboard trên thanh công cụ: dán (⌘V / Ctrl+V) trong màn hình điều khiển sẽ gửi văn bản sang Windows; văn bản copy trên Windows sẽ được chép về đây.</p>
      <ol class="clip-list"></ol>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const transcript = $<HTMLOListElement>('.chat-transcript');
  const typingEl = $<HTMLParagraphElement>('.chat-typing');
  const unavailableEl = $<HTMLParagraphElement>('.chat-unavailable');
  const errorEl = $<HTMLParagraphElement>('.chat-error');
  const input = $<HTMLTextAreaElement>('.chat-input');
  const sendButton = $<HTMLButtonElement>('.chat-send');
  const attachButton = $<HTMLButtonElement>('.chat-attach');
  const fileInput = $<HTMLInputElement>('.chat-file');
  const chatPane = $<HTMLDivElement>('.chat-pane-chat');
  const clipPane = $<HTMLDivElement>('.chat-pane-clipboard');
  const clipList = $<HTMLOListElement>('.clip-list');
  const clipEmpty = $<HTMLParagraphElement>('.clip-empty');
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('.chat-tab')];

  attachButton.disabled = true;
  let open = false;
  let unread = 0;
  let available = false;
  let sending = false;
  /** Bumped when the session ends: late send/typing results are ignored. */
  let generation = 0;
  let messages: Message[] = [];
  let totalBytes = 0;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let peerTypingTimer: ReturnType<typeof setTimeout> | null = null;

  const report = () => h.changed({ open, unread });

  const showError = (text: string | null) => {
    errorEl.textContent = text ?? '';
    errorEl.hidden = text === null;
  };

  const cancelTyping = () => {
    if (typingTimer !== null) clearTimeout(typingTimer);
    typingTimer = null;
  };

  /** Swift draftChanged: 0.25 s debounce, then typing(!empty); "true" is followed by "false" after 2 s. */
  const draftChanged = () => {
    cancelTyping();
    if (!available) return;
    const token = generation;
    const typing = input.value !== '';
    typingTimer = setTimeout(() => {
      typingTimer = null;
      if (token !== generation || !available) return;
      h.typing(typing).catch(() => {});
      if (!typing) return;
      typingTimer = setTimeout(() => {
        typingTimer = null;
        if (token === generation && available) h.typing(false).catch(() => {});
      }, TYPING_IDLE_MS);
    }, TYPING_DEBOUNCE_MS);
  };

  const setPeerTyping = (typing: boolean) => {
    if (peerTypingTimer !== null) clearTimeout(peerTypingTimer);
    peerTypingTimer = null;
    typingEl.hidden = !typing;
    if (typing) {
      peerTypingTimer = setTimeout(() => {
        peerTypingTimer = null;
        typingEl.hidden = true;
      }, PEER_TYPING_MS);
    }
  };

  const append = (text: string, outgoing: boolean) => {
    const li = document.createElement('li');
    li.className = `chat-message ${outgoing ? 'outgoing' : 'incoming'}`;
    const body = document.createElement('div');
    body.className = 'chat-text';
    body.textContent = text;
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    meta.textContent = `${outgoing ? 'Bạn' : 'Máy Windows'} · ${clock(new Date())}`;
    li.append(body, meta);
    const stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 24;
    transcript.append(li);
    const bytes = utf8.encode(text).length;
    messages.push({ el: li, bytes });
    totalBytes += bytes;
    // Bound both the item count and the text storage (Swift append).
    while (messages.length > MAX_TRANSCRIPT_MESSAGES || totalBytes > MAX_TRANSCRIPT_BYTES) {
      const first = messages.shift()!;
      totalBytes -= first.bytes;
      first.el.remove();
    }
    if (stick || outgoing) transcript.scrollTop = transcript.scrollHeight;
  };

  const sendDraft = () => {
    const text = input.value;
    if (!available || sending || text.trim() === '') return;
    if (text.length > MAX_CHAT_UNITS) {
      showError('Tin nhắn tối đa 16.384 ký tự.');
      return;
    }
    const token = generation;
    sending = true;
    sendButton.disabled = true;
    showError(null);
    h.send(text).then(
      () => {
        if (token !== generation) return;
        append(text, true);
        if (input.value === text) {
          input.value = '';
          draftChanged();
        }
      },
      (e: unknown) => {
        if (token === generation) showError(chatErrorText(e));
      },
    ).finally(() => {
      if (token !== generation) return;
      sending = false;
      sendButton.disabled = !available;
    });
  };

  const selectTab = (tab: ChatTab) => {
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
    chatPane.hidden = tab !== 'chat';
    clipPane.hidden = tab !== 'clipboard';
  };

  const hide = () => {
    root.hidden = true;
    open = false;
    report();
  };

  input.addEventListener('input', () => {
    showError(null);
    draftChanged();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      panel.close();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendDraft();
  });
  sendButton.addEventListener('click', () => sendDraft());
  attachButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    // Clear the selection so choosing the same file again fires `change`.
    fileInput.value = '';
    if (available && files.length > 0) h.attach(files);
  });
  const detachDrop = attachDropZone(root, {
    enabled: () => available,
    hint: 'Thả file để gửi sang máy Windows',
    onFiles: (files) => h.attach(files),
  });
  for (const t of tabs) t.addEventListener('click', () => selectTab(t.dataset.tab as ChatTab));
  $<HTMLButtonElement>('.chat-close').addEventListener('click', () => panel.close());

  const panel: ChatPanel = {
    get isOpen() {
      return open;
    },
    open(tab, focus = true) {
      if (tab) selectTab(tab);
      root.hidden = false;
      open = true;
      unread = 0;
      report();
      transcript.scrollTop = transcript.scrollHeight;
      if (focus && !chatPane.hidden && !input.disabled) input.focus({ preventScroll: true });
    },
    close() {
      if (!open) return;
      hide();
      h.closed();
    },
    setAvailable(next, reason) {
      available = next;
      input.disabled = !next;
      sendButton.disabled = !next || sending;
      attachButton.disabled = !next;
      unavailableEl.textContent = next ? '' : (reason ?? '');
      unavailableEl.hidden = next || !reason;
      if (!next) {
        cancelTyping();
        setPeerTyping(false);
      }
    },
    receive(text) {
      if (text.length > MAX_CHAT_UNITS) return;
      setPeerTyping(false);
      append(text, false);
      if (!open) {
        unread++;
        report();
      }
    },
    addCard(card, incoming) {
      const stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 24;
      transcript.append(card);
      if (stick || !incoming) transcript.scrollTop = transcript.scrollHeight;
      if (incoming && !open) {
        unread++;
        report();
      }
    },
    setPeerTyping,
    setClipboardHistory(entries) {
      clipEmpty.hidden = entries.length > 0;
      clipList.replaceChildren(
        ...entries.map((entry) => {
          const li = document.createElement('li');
          li.className = `clip-entry ${entry.outgoing ? 'outgoing' : 'incoming'}`;
          const meta = document.createElement('div');
          meta.className = 'clip-meta';
          meta.textContent = `${entry.outgoing ? 'Gửi đi' : 'Từ máy Windows'} · ${clock(entry.at)}`;
          const text = document.createElement('div');
          text.className = 'clip-text';
          text.textContent = entry.text.length > CLIP_PREVIEW_UNITS ? `${entry.text.slice(0, CLIP_PREVIEW_UNITS)}…` : entry.text;
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'clip-copy';
          copy.textContent = 'Sao chép';
          copy.addEventListener('click', () => h.copy(entry.text));
          li.append(meta, text, copy);
          return li;
        }),
      );
    },
    reset() {
      generation++;
      sending = false;
      cancelTyping();
      setPeerTyping(false);
      for (const m of messages) m.el.remove();
      messages = [];
      totalBytes = 0;
      input.value = '';
      showError(null);
      unread = 0;
      selectTab('chat');
      if (open) hide();
      else report();
    },
    dispose() {
      generation++;
      cancelTyping();
      setPeerTyping(false);
      detachDrop();
    },
  };
  return panel;
}
