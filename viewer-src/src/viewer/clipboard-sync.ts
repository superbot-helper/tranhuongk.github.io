// Opt-in clipboard sharing with the Windows side (Review Focus 1), after MacViewer's
// SessionToolsModel (receiveClipboard, recordClipboard, latestClipboardText, 20-item history,
// 3 s notice). A page cannot read the local clipboard in the background, so this side is sent
// only when the user pastes into the viewer (`paste` on the hidden textarea); the caller then
// types Ctrl+V on Windows. Text copied on Windows is written with navigator.clipboard.writeText;
// when the browser refuses (Safari outside a user gesture, no Clipboard API) a toast offers a
// "Sao chép" button that writes inside its click. The last text sent or received is remembered
// so neither side bounces it back. Nothing here is persisted or logged with its content.

/** Text that crossed the shared clipboard during this session. */
export interface ClipboardEntry {
  text: string;
  /** Sent to Windows (true) or copied from Windows (false). */
  outgoing: boolean;
  at: Date;
}

export const CLIPBOARD_HISTORY_MAX = 20;
export const CLIPBOARD_NOTICE_MS = 3_000;
/** 1 MiB of UTF-16 text (Swift 524,288 units). */
export const MAX_CLIPBOARD_UNITS = 524_288;

export interface ClipboardSyncDeps {
  /** session.sendClipboard. */
  send(text: string): Promise<void>;
  /** History changed (newest first). */
  history(entries: readonly ClipboardEntry[]): void;
  /** Content-free diagnostics line. */
  log(line: string): void;
  /** Defaults to navigator.clipboard.writeText (missing API = rejected). */
  writeText?: (text: string) => Promise<void>;
}

function defaultWriteText(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) return Promise.reject(new Error('NoClipboardApi'));
  return clipboard.writeText(text);
}

function errorName(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') return e.code;
  return e instanceof Error ? e.name : 'Error';
}

export class ClipboardSync {
  private on = false;
  /** The last text sent to or received from Windows (echo guard). */
  private lastText: string | null = null;
  private entries: ClipboardEntry[] = [];
  /** Received text waiting for the toast's "Sao chép" (the browser refused to write it). */
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly textEl: HTMLSpanElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly writeText: (text: string) => Promise<void>;

  constructor(
    private readonly toast: HTMLElement,
    private readonly deps: ClipboardSyncDeps,
  ) {
    this.writeText = deps.writeText ?? defaultWriteText;
    toast.classList.add('toast');
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    toast.innerHTML = `<span class="toast-text"></span>
      <button type="button" class="toast-copy" hidden>Sao chép</button>
      <button type="button" class="toast-close" aria-label="Đóng">×</button>`;
    this.textEl = toast.querySelector<HTMLSpanElement>('.toast-text')!;
    this.copyButton = toast.querySelector<HTMLButtonElement>('.toast-copy')!;
    // The toast's buttons never take the keyboard from the remote screen.
    toast.addEventListener('mousedown', (e) => {
      if ((e.target as Element | null)?.closest('button')) e.preventDefault();
    });
    this.copyButton.addEventListener('click', () => {
      const text = this.pending;
      if (text === null) return;
      // Inside the click: the user gesture lets Safari write.
      this.writeText(text).then(
        () => {
          if (this.pending === text) this.notice('Đã chép văn bản từ máy Windows.');
        },
        (e: unknown) => {
          this.deps.log(`Chép clipboard bị trình duyệt từ chối (${errorName(e)})`);
          if (this.pending === text) this.notice('Trình duyệt không cho chép: mở Chat → Clipboard để chép lại.');
        },
      );
    });
    toast.querySelector<HTMLButtonElement>('.toast-close')!.addEventListener('click', () => this.hide());
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Sharing switched (already applied to the session). A fresh start forgets the echo guard. */
  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.lastText = null;
    if (!on) this.hide();
  }

  /**
   * The user pasted `text` into the viewer. Uploads it when sharing is on and it is new; resolves
   * true when Ctrl+V should follow (false: the upload failed, pasting would paste stale text).
   */
  async paste(text: string): Promise<boolean> {
    if (!this.on || text === '' || text === this.lastText) return true;
    if (text.length > MAX_CLIPBOARD_UNITS) {
      this.notice('Văn bản quá lớn để gửi (tối đa 1 MiB).');
      return false;
    }
    try {
      await this.deps.send(text);
    } catch (e) {
      this.deps.log(`Gửi clipboard lỗi: ${errorName(e)}`);
      this.notice('Không gửi được clipboard tới máy Windows.');
      return false;
    }
    this.lastText = text;
    this.record(text, true);
    this.notice('Đã gửi clipboard tới máy Windows.');
    return true;
  }

  /** Windows copied `text` (only delivered while sharing is on). */
  receive(text: string): void {
    if (!this.on || text.length > MAX_CLIPBOARD_UNITS || text === this.lastText) return;
    this.lastText = text;
    this.record(text, false);
    this.writeText(text).then(
      () => {
        if (this.lastText === text) this.notice('Đã chép văn bản từ máy Windows.');
      },
      () => {
        if (this.lastText !== text || !this.on) return;
        this.pending = text;
        this.show('Máy Windows vừa copy văn bản.', true);
      },
    );
  }

  /** A history entry's copy button (inside its click). */
  copy(text: string): void {
    this.writeText(text).then(
      () => this.notice('Đã chép vào clipboard của thiết bị này.'),
      (e: unknown) => {
        this.deps.log(`Chép clipboard bị trình duyệt từ chối (${errorName(e)})`);
        this.notice('Trình duyệt không cho chép.');
      },
    );
  }

  /** Session ended: sharing off, history and echo guard forgotten (Swift deactivate). */
  reset(): void {
    this.on = false;
    this.lastText = null;
    this.entries = [];
    this.deps.history(this.entries);
    this.hide();
  }

  dispose(): void {
    this.hide();
  }

  private record(text: string, outgoing: boolean): void {
    this.entries = [{ text, outgoing, at: new Date() }, ...this.entries].slice(0, CLIPBOARD_HISTORY_MAX);
    this.deps.history(this.entries);
  }

  private notice(text: string): void {
    this.show(text, false);
  }

  private show(text: string, withCopy: boolean): void {
    if (!withCopy) this.pending = null;
    this.textEl.textContent = text;
    this.copyButton.hidden = !withCopy;
    this.toast.hidden = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), CLIPBOARD_NOTICE_MS);
  }

  private hide(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.copyButton.hidden = true;
    this.toast.hidden = true;
  }
}
