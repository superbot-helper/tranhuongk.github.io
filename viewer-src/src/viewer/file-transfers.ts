// File transfer UI, after MacViewer's SessionFileTransfers/SessionToolsView: one card per file in the
// chat transcript (name, size, progress bar, percent + speed, Save/Cancel) for both directions, plus
// the drag-and-drop zone used on the chat panel and on the screen.
//  - Sending reads the file by File.slice, part by part (the engine pulls; nothing is loaded whole).
//  - Receiving writes through the File System Access API when the browser has it (the sink is a
//    FileSystemWritableFileStream: bytes are committed only by close(), so a cancelled or
//    interrupted transfer leaves no partial data). Otherwise the parts are gathered in memory (up
//    to 512 MiB); when complete, the card offers a "Tải về" button and the download (<a download>)
//    starts inside that click (browsers such as Safari block downloads without a user gesture).
//  - Progress repaints are throttled to about 4 per second per card.
// File names are rendered with textContent only and never logged; the cards carry no contents.
import { FileOfferError } from '../proto/file-offer';
import {
  FILE_INVALID_RANGE_REASON,
  FILE_IO_REASON,
  FileTransferError,
  type FileEvent,
  type FileSink,
  type FileSource,
} from '../session/file-engine';

/** Without File System Access the whole file lives in memory: refuse anything larger. */
export const BLOB_LIMIT_BYTES = 512 * 1024 * 1024;
export const PROGRESS_INTERVAL_MS = 250;
const SPEED_WINDOW_MS = 3_000;
/** An object URL is revoked this long after the download was started. */
const REVOKE_DELAY_MS = 60_000;

const NOT_READY = 'Chưa kết nối xong với máy Windows.';

/** The RelaySession surface this UI uses. */
export interface FileTransferSession {
  sendFile(name: string, source: FileSource): string;
  acceptFile(id: string, sink: FileSink): Promise<void>;
  cancelFile(id: string): Promise<void>;
}

/** The parts of FileSystemWritableFileStream the sink needs. */
export interface WritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}
type SavePicker = (options: { suggestedName: string }) => Promise<FileHandleLike>;

const noop = (): void => {};

/** Run an async cleanup; a throw or rejection is swallowed (cleanup must never break the page). */
function quiet(fn: () => Promise<void>): void {
  try {
    fn().catch(noop);
  } catch {
    // Ignored on purpose.
  }
}

// --- sinks ---------------------------------------------------------------

/**
 * Streams into a file the user picked. The stream stays uncommitted until `close()`, so `abort()`
 * (cancel, error, disconnect) leaves nothing but the empty file the picker created. `abort()` after
 * `close()` and `close()` after `abort()` are no-ops.
 */
export class FsSink implements FileSink {
  private state: 'open' | 'closed' | 'aborted' = 'open';

  constructor(private readonly writable: WritableLike) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.state !== 'open') throw new Error('sink is not open');
    await this.writable.write(chunk);
  }

  async close(): Promise<void> {
    if (this.state !== 'open') return;
    await this.writable.close();
    this.state = 'closed';
  }

  async abort(): Promise<void> {
    if (this.state === 'closed' || this.state === 'aborted') return;
    this.state = 'aborted';
    try {
      await this.writable.abort();
    } catch {
      // The stream may already be errored or closing; nothing is committed either way.
    }
  }
}

/** Buffered parts beyond this size are folded into one Blob so the browser may spill them to disk. */
const BLOB_CONSOLIDATE_BYTES = 8 * 1024 * 1024;

/**
 * Gathers the parts; `take()` yields the finished Blob once. The sink takes ownership of the chunk
 * (the file engine hands it a private copy). Parts are folded into a Blob every ~8 MiB so a big file
 * is not held as many JS-heap buffers (phones can crash the tab with ~2x peak otherwise).
 */
export class BlobSink implements FileSink {
  private state: 'open' | 'closed' | 'aborted' = 'open';
  private blob: Blob | null = null;
  private parts: Uint8Array[] = [];
  private pending = 0;
  private total = 0;

  constructor(private readonly limit: number = BLOB_LIMIT_BYTES) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.state !== 'open') throw new Error('sink is not open');
    if (this.total + chunk.length > this.limit) throw new Error('memory limit');
    this.total += chunk.length;
    this.parts.push(chunk);
    this.pending += chunk.length;
    if (this.pending > BLOB_CONSOLIDATE_BYTES) this.consolidate();
  }

  async close(): Promise<void> {
    if (this.state === 'open') this.state = 'closed';
  }

  async abort(): Promise<void> {
    if (this.state !== 'open') return;
    this.state = 'aborted';
    this.blob = null;
    this.parts = [];
    this.pending = 0;
    this.total = 0;
  }

  /** The complete file, or null when the sink was aborted or is not finished. Frees the buffers. */
  take(): Blob | null {
    if (this.state !== 'closed') return null;
    this.consolidate();
    const blob = this.blob ?? new Blob([]);
    this.blob = null;
    this.total = 0;
    return blob;
  }

  private consolidate(): void {
    if (this.parts.length === 0) return;
    const pieces: BlobPart[] = this.blob ? [this.blob, ...(this.parts as BlobPart[])] : (this.parts as BlobPart[]);
    this.blob = new Blob(pieces);
    this.parts = [];
    this.pending = 0;
  }
}

// --- helpers ---------------------------------------------------------------

function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1).replace('.', ',')} ${units[unit]}`;
}

/** A name the save dialog accepts (no path separators, reserved characters or control characters). */
function suggestedName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim();
  if (safe === '' || safe === '.' || safe === '..') safe = 'file';
  const encoder = new TextEncoder();
  const chars = Array.from(safe);
  while (chars.length > 1 && encoder.encode(chars.join('')).length > 240) chars.pop();
  return chars.join('');
}

function failureText(reason: string): string {
  switch (reason) {
    case FILE_INVALID_RANGE_REASON:
      return 'Máy Windows gửi dữ liệu file sai vị trí hoặc độ dài.';
    case FILE_IO_REASON:
      return 'Không đọc hoặc lưu được file.';
    default:
      return 'Truyền file không thành công.';
  }
}

function sendErrorText(e: unknown): string {
  if (e instanceof FileOfferError) {
    switch (e.code) {
      case 'invalidFileName':
        return 'Tên file không gửi được (rỗng, quá dài hoặc có ký tự đặc biệt).';
      case 'invalidSize':
        return 'Kích thước file không hợp lệ.';
      default:
        return 'Không gửi được file này.';
    }
  }
  if (e instanceof FileTransferError && e.code === 'tooManyTransfers') {
    return 'Đang có quá nhiều file được truyền (tối đa 16). Hãy chờ hoặc huỷ bớt.';
  }
  if (e instanceof Error && e.name === 'RelaySessionError') return NOT_READY;
  return 'Không gửi được file này.';
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function savePicker(): SavePicker | undefined {
  const picker = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  return typeof picker === 'function' ? (picker as SavePicker).bind(window) : undefined;
}

/** Wraps a File as a FileSource: random access by `File.slice`, one part at a time. */
function fileSource(f: File): FileSource {
  return {
    size: f.size,
    read: async (offset, length) => new Uint8Array(await f.slice(offset, offset + length).arrayBuffer()),
  };
}

// --- cards -----------------------------------------------------------------

type State = 'offered' | 'saving' | 'waiting' | 'transferring' | 'completed' | 'canceled' | 'failed';

interface Sample {
  t: number;
  bytes: number;
}

interface Card {
  /** Empty for a file that could not even be offered. */
  id: string;
  name: string;
  size: number;
  incoming: boolean;
  state: State;
  note: string;
  failure: string;
  /** How a finished incoming file was kept. */
  kept: 'disk' | 'download';
  sink: FileSink | null;
  /** A finished in-memory file waiting for the "Tải về" click; released once downloaded. */
  blob: Blob | null;
  bytes: number;
  samples: Sample[];
  lastPaint: number;
  timer: ReturnType<typeof setTimeout> | null;
  el: HTMLLIElement;
  bar: HTMLProgressElement;
  statusEl: HTMLElement;
  noteEl: HTMLElement;
  saveButton: HTMLButtonElement;
  downloadButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
}

const isFinal = (c: Card): boolean => c.state === 'completed' || c.state === 'canceled' || c.state === 'failed';

export interface FileTransfersHost {
  session(): FileTransferSession | null;
  /** Put a card in the chat transcript; `incoming` offers count as unread while the panel is closed. */
  addCard(card: HTMLElement, incoming: boolean): void;
  /** Monotonic clock in ms (tests). */
  now?: () => number;
}

/** A received file nobody downloaded yet; `download()` must run inside a user click. */
export interface UnclaimedFile {
  name: string;
  size: number;
  /** Starts the download and releases the file. */
  download(): void;
  /** Drops the file without saving it. */
  release(): void;
}

export interface FileTransfers {
  /** Offer files chosen with the picker or dropped; each gets an outgoing card. */
  send(files: readonly File[]): void;
  /** A `file` event of the session. */
  handle(event: FileEvent): void;
  /** Finished incoming files still waiting for their "Tải về" click (kept in memory). */
  unclaimed(): UnclaimedFile[];
  /** The session ended: running transfers become "đã huỷ", open save dialogs are discarded. */
  reset(): void;
  /** A new session starts: remove every card. */
  clear(): void;
  dispose(): void;
}

export function createFileTransfers(host: FileTransfersHost): FileTransfers {
  const now = host.now ?? (() => performance.now());
  const byId = new Map<string, Card>();
  const all: Card[] = [];
  const downloadUrls = new Map<string, ReturnType<typeof setTimeout>>();
  /** Bumped by reset()/clear(): asynchronous work started before it must not touch the session. */
  let generation = 0;

  function speedOf(card: Card): number {
    const newest = card.samples[card.samples.length - 1];
    const oldest = card.samples[0];
    if (!newest || !oldest || newest === oldest || now() - newest.t > SPEED_WINDOW_MS) return 0;
    const dt = newest.t - oldest.t;
    return dt <= 0 ? 0 : ((newest.bytes - oldest.bytes) * 1000) / dt;
  }

  function paint(card: Card): void {
    if (card.timer !== null) clearTimeout(card.timer);
    card.timer = null;
    card.lastPaint = now();
    const { state } = card;
    card.el.dataset.state = state;
    const percent = card.size > 0 ? Math.min(100, Math.floor((card.bytes / card.size) * 100)) : state === 'completed' ? 100 : 0;
    card.bar.hidden = state !== 'transferring';
    card.bar.value = percent;
    let text: string;
    switch (state) {
      case 'offered':
        text = 'Máy Windows muốn gửi file này.';
        break;
      case 'saving':
        text = 'Đang chọn nơi lưu…';
        break;
      case 'waiting':
        text = 'Đang chờ máy Windows chấp nhận…';
        break;
      case 'transferring': {
        const speed = speedOf(card);
        text = `${percent}% · ${formatBytes(card.bytes)} / ${formatBytes(card.size)}${speed > 0 ? ` · ${formatBytes(speed)}/s` : ''}`;
        break;
      }
      case 'completed':
        text = card.incoming ? (card.kept === 'disk' ? 'Đã lưu xong' : card.blob !== null ? 'Xong — bấm Tải về để lưu' : 'Đã tải về') : 'Đã gửi xong';
        break;
      case 'canceled':
        text = 'Đã huỷ';
        break;
      case 'failed':
        text = `Lỗi: ${card.failure}`;
        break;
    }
    card.statusEl.textContent = text;
    card.noteEl.textContent = card.note;
    card.noteEl.hidden = card.note === '';
    // Save only exists while an incoming offer is undecided; Cancel until the card is final.
    const waitingForUser = card.incoming && (state === 'offered' || state === 'saving');
    card.saveButton.hidden = !waitingForUser;
    card.saveButton.disabled = state === 'saving' || tooBigForMemory(card);
    card.downloadButton.hidden = !(state === 'completed' && card.blob !== null);
    card.cancelButton.hidden = isFinal(card) || card.id === '';
  }

  function tooBigForMemory(card: Card): boolean {
    return card.incoming && card.size > BLOB_LIMIT_BYTES && savePicker() === undefined;
  }

  function finish(card: Card, state: 'completed' | 'canceled' | 'failed', failure = ''): void {
    if (isFinal(card)) return;
    card.state = state;
    card.failure = failure;
    card.note = '';
    if (state !== 'completed' && card.sink !== null) {
      // The engine aborts the sink as well (idempotent); this frees the memory of a Blob sink at once.
      const sink = card.sink;
      quiet(() => sink.abort());
    }
    card.sink = null;
    paint(card);
  }

  /** Repaint progress at most every PROGRESS_INTERVAL_MS. */
  function schedule(card: Card): void {
    if (card.timer !== null) return;
    const wait = card.lastPaint + PROGRESS_INTERVAL_MS - now();
    if (wait <= 0) paint(card);
    else card.timer = setTimeout(() => paint(card), wait);
  }

  function makeCard(id: string, name: string, size: number, incoming: boolean, state: State): Card {
    const el = document.createElement('li');
    el.className = `file-card ${incoming ? 'incoming' : 'outgoing'}`;
    // The transcript is a polite live region; per-tick progress must not be announced.
    el.setAttribute('aria-live', 'off');
    const nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    nameEl.textContent = name;
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = `${incoming ? 'Từ máy Windows' : 'Gửi sang máy Windows'} · ${formatBytes(size)}`;
    const bar = document.createElement('progress');
    bar.className = 'file-bar';
    bar.max = 100;
    bar.value = 0;
    bar.hidden = true;
    const statusEl = document.createElement('div');
    statusEl.className = 'file-status';
    const noteEl = document.createElement('div');
    noteEl.className = 'file-note';
    noteEl.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'file-save';
    saveButton.textContent = 'Lưu';
    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'file-download';
    downloadButton.textContent = 'Tải về';
    downloadButton.hidden = true;
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'file-cancel';
    cancelButton.textContent = 'Huỷ';
    actions.append(saveButton, downloadButton, cancelButton);
    el.append(nameEl, meta, bar, statusEl, noteEl, actions);
    const card: Card = {
      id, name, size, incoming, state, note: '', failure: '', kept: 'download', sink: null, blob: null, bytes: 0, samples: [],
      lastPaint: Number.NEGATIVE_INFINITY, timer: null, el, bar, statusEl, noteEl, saveButton, downloadButton, cancelButton,
    };
    if (incoming && tooBigForMemory(card)) {
      card.note = 'File lớn hơn 512 MiB: cần trình duyệt có File System Access (Chrome, Edge) để lưu thẳng ra đĩa.';
    }
    saveButton.addEventListener('click', () => save(card));
    downloadButton.addEventListener('click', () => {
      const blob = card.blob;
      if (blob === null) return;
      // Inside the click: this is the user gesture the browser wants for a download.
      download(card, blob);
      card.blob = null;
      paint(card);
    });
    cancelButton.addEventListener('click', () => cancel(card));
    all.push(card);
    if (id !== '') byId.set(id, card);
    paint(card);
    host.addCard(el, incoming);
    return card;
  }

  function cancel(card: Card): void {
    if (isFinal(card) || card.id === '') return;
    const session = host.session();
    if (!session) {
      finish(card, 'canceled');
      return;
    }
    // The `canceled` event updates the card; a failed notification to the host changes nothing here.
    session.cancelFile(card.id).catch(noop);
  }

  function startAccept(card: Card, session: FileTransferSession, sink: FileSink, kept: 'disk' | 'download'): void {
    card.sink = sink;
    card.kept = kept;
    card.state = 'saving';
    paint(card);
    session.acceptFile(card.id, sink).catch(() => {
      quiet(() => sink.abort());
      finish(card, 'failed', 'Không nhận được file (lời mời đã hết hạn hoặc không gửi được xác nhận).');
    });
  }

  function save(card: Card): void {
    if (card.state !== 'offered' || !card.incoming) return;
    const session = host.session();
    if (!session) return;
    const picker = savePicker();
    if (picker === undefined) {
      if (tooBigForMemory(card)) return;
      startAccept(card, session, new BlobSink(), 'download');
      return;
    }
    // showSaveFilePicker needs the user activation of this very click: ask before anything async.
    let pending: Promise<FileHandleLike>;
    try {
      pending = picker({ suggestedName: suggestedName(card.name) });
    } catch (e) {
      pending = Promise.reject(e);
    }
    const token = generation;
    card.state = 'saving';
    card.note = '';
    paint(card);
    void (async () => {
      let writable: WritableLike;
      try {
        writable = await (await pending).createWritable();
      } catch (e) {
        if (token === generation && card.state === 'saving') {
          card.state = 'offered';
          card.note = isAbort(e) ? '' : 'Không mở được nơi lưu file. Thử chọn chỗ khác.';
          paint(card);
        }
        return;
      }
      const current = token === generation && card.state === 'saving' ? host.session() : null;
      if (current === null) {
        // Cancelled, rejected by the host or disconnected while the dialog was open: drop the file.
        quiet(() => writable.abort());
        return;
      }
      startAccept(card, current, new FsSink(writable), 'disk');
    })();
  }

  function download(card: Card, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = card.name;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    downloadUrls.set(
      url,
      setTimeout(() => {
        downloadUrls.delete(url);
        URL.revokeObjectURL(url);
      }, REVOKE_DELAY_MS),
    );
  }

  function onProgress(card: Card, bytes: number): void {
    if (isFinal(card)) return;
    const t = now();
    card.bytes = bytes;
    card.samples.push({ t, bytes });
    while (card.samples.length > 2 && t - card.samples[1]!.t >= SPEED_WINDOW_MS) card.samples.shift();
    if (card.state !== 'transferring') {
      card.state = 'transferring';
      paint(card);
    } else {
      schedule(card);
    }
  }

  return {
    send(files) {
      for (const f of files) {
        const session = host.session();
        let id: string | null = null;
        let failure = NOT_READY;
        if (session) {
          try {
            id = session.sendFile(f.name, fileSource(f));
          } catch (e) {
            failure = sendErrorText(e);
          }
        }
        if (id === null) {
          const card = makeCard('', f.name, f.size, false, 'waiting');
          finish(card, 'failed', failure);
        } else {
          makeCard(id, f.name, f.size, false, 'waiting');
        }
      }
    },

    handle(event) {
      if (event.type === 'incoming') {
        if (!byId.has(event.id)) makeCard(event.id, event.name, event.size, true, 'offered');
        return;
      }
      const card = byId.get(event.id);
      if (!card) return;
      switch (event.type) {
        case 'progress':
          card.size = event.total;
          onProgress(card, event.bytes);
          break;
        case 'completed': {
          if (isFinal(card)) break;
          if (card.incoming && card.sink instanceof BlobSink) {
            const blob = card.sink.take();
            if (blob === null) {
              finish(card, 'failed', failureText(FILE_IO_REASON));
              break;
            }
            card.blob = blob;
          }
          card.bytes = card.size;
          card.sink = null;
          finish(card, 'completed');
          break;
        }
        case 'canceled':
          finish(card, 'canceled');
          break;
        case 'failed':
          finish(card, 'failed', failureText(event.reason));
          break;
      }
    },

    unclaimed() {
      const files: UnclaimedFile[] = [];
      for (const card of all) {
        if (!card.incoming || card.state !== 'completed' || card.blob === null) continue;
        files.push({
          name: card.name,
          size: card.size,
          download() {
            const blob = card.blob;
            if (blob === null) return;
            download(card, blob);
            card.blob = null;
            paint(card);
          },
          release() {
            if (card.blob === null) return;
            card.blob = null;
            paint(card);
          },
        });
      }
      return files;
    },

    reset() {
      generation++;
      for (const card of all) finish(card, 'canceled');
    },

    clear() {
      generation++;
      for (const card of all) {
        if (card.timer !== null) clearTimeout(card.timer);
        card.timer = null;
        card.blob = null;
        if (!isFinal(card)) finish(card, 'canceled');
        card.el.remove();
      }
      all.length = 0;
      byId.clear();
    },

    dispose() {
      this.clear();
      for (const [url, timer] of downloadUrls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloadUrls.clear();
    },
  };
}

// --- drag and drop -----------------------------------------------------------

export interface DropZoneOptions {
  /** False while sending is not possible: files are swallowed (the browser must not open them) but not sent. */
  enabled(): boolean;
  /** Text of the overlay shown while files are dragged over the target. */
  hint: string;
  onFiles(files: File[]): void;
  /** Where the overlay goes (default: the target itself; it must be positioned). */
  overlayParent?: HTMLElement;
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/** Folders cannot be read as files: they are left out. */
function droppedFiles(dt: DataTransfer): File[] {
  const files: File[] = [];
  for (let i = 0; i < dt.files.length; i++) {
    const entry = dt.items?.[i]?.webkitGetAsEntry?.();
    if (entry?.isDirectory) continue;
    files.push(dt.files[i]!);
  }
  return files;
}

/**
 * Makes `target` accept dropped files, with an overlay while they hover over it. Dragging never
 * produces pointer events, so a drop on the screen cannot move or click the remote pointer.
 */
export function attachDropZone(target: HTMLElement, o: DropZoneOptions): () => void {
  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.textContent = o.hint;
  overlay.hidden = true;
  (o.overlayParent ?? target).append(overlay);
  let depth = 0;

  const hide = () => {
    depth = 0;
    overlay.hidden = true;
  };
  const enter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = !o.enabled();
  };
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = o.enabled() ? 'copy' : 'none';
    overlay.hidden = !o.enabled();
  };
  const leave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    hide();
    if (!o.enabled() || !e.dataTransfer) return;
    const files = droppedFiles(e.dataTransfer);
    if (files.length > 0) o.onFiles(files);
  };

  target.addEventListener('dragenter', enter as EventListener);
  target.addEventListener('dragover', over as EventListener);
  target.addEventListener('dragleave', leave as EventListener);
  target.addEventListener('drop', drop as EventListener);
  return () => {
    target.removeEventListener('dragenter', enter as EventListener);
    target.removeEventListener('dragover', over as EventListener);
    target.removeEventListener('dragleave', leave as EventListener);
    target.removeEventListener('drop', drop as EventListener);
    overlay.remove();
  };
}
