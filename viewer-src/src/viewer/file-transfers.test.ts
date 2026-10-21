// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FileOfferError } from '../proto/file-offer';
import { FILE_INVALID_RANGE_REASON, FILE_IO_REASON, FileTransferError, type FileEvent, type FileSink, type FileSource } from '../session/file-engine';
import {
  attachDropZone,
  BLOB_LIMIT_BYTES,
  BlobSink,
  createFileTransfers,
  FsSink,
  PROGRESS_INTERVAL_MS,
  type FileTransfers,
  type FileTransferSession,
} from './file-transfers';

class FakeFiles implements FileTransferSession {
  readonly offered: Array<{ id: string; name: string; source: FileSource }> = [];
  readonly accepted = new Map<string, FileSink>();
  readonly canceled: string[] = [];
  sendError: unknown = null;
  acceptError: unknown = null;
  private n = 0;

  sendFile(name: string, source: FileSource): string {
    if (this.sendError) throw this.sendError;
    const id = `t${++this.n}`;
    this.offered.push({ id, name, source });
    return id;
  }

  async acceptFile(id: string, sink: FileSink): Promise<void> {
    if (this.acceptError) throw this.acceptError;
    this.accepted.set(id, sink);
  }

  async cancelFile(id: string): Promise<void> {
    this.canceled.push(id);
  }
}

class FakeWritable {
  readonly parts: Uint8Array[] = [];
  closed = 0;
  aborted = 0;
  failWrite = false;
  async write(chunk: Uint8Array): Promise<void> {
    if (this.failWrite) throw new Error('disk full');
    this.parts.push(chunk.slice());
  }
  async close(): Promise<void> {
    this.closed++;
  }
  async abort(): Promise<void> {
    this.aborted++;
  }
  get bytes(): number[] {
    return this.parts.flatMap((p) => [...p]);
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const bytesOf = async (blob: Blob): Promise<number[]> => [...new Uint8Array(await blob.arrayBuffer())];
const file = (name: string, content: number[] | string): File => new File([typeof content === 'string' ? content : new Uint8Array(content)], name);

describe('file transfer cards', () => {
  let list: HTMLOListElement;
  let session: FakeFiles | null;
  let added: boolean[];
  let transfers: FileTransfers;
  let clock: number;
  let urls: Blob[];
  let revoked: string[];
  let downloads: Array<{ name: string; href: string }>;
  const win = window as unknown as { showSaveFilePicker?: unknown };

  const cards = () => [...list.querySelectorAll<HTMLElement>('.file-card')];
  const card = (i = 0) => cards()[i]!;
  const status = (i = 0) => card(i).querySelector('.file-status')!.textContent;
  const button = (cls: string, i = 0) => card(i).querySelector<HTMLButtonElement>(`.${cls}`)!;
  const shown = (cls: string, i = 0) => !card(i).querySelector<HTMLElement>(`.${cls}`)!.hidden;
  const emit = (event: FileEvent) => transfers.handle(event);
  const offer = (id: string, name: string, size: number) => emit({ type: 'incoming', id, name, size });

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
    document.body.innerHTML = '<ol id="list"></ol>';
    list = document.getElementById('list') as HTMLOListElement;
    session = new FakeFiles();
    added = [];
    urls = [];
    revoked = [];
    downloads = [];
    delete win.showSaveFilePicker;
    Object.assign(URL, {
      createObjectURL: (b: Blob) => {
        urls.push(b);
        return `blob:fake/${urls.length}`;
      },
      revokeObjectURL: (u: string) => revoked.push(u),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, href: this.href });
    });
    transfers = createFileTransfers({
      session: () => session,
      addCard: (el, incoming) => {
        list.append(el);
        added.push(incoming);
      },
      now: () => clock,
    });
  });

  afterEach(() => {
    transfers.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete win.showSaveFilePicker;
  });

  describe('sending', () => {
    test('each chosen file is offered with a File.slice source and gets an outgoing card', async () => {
      vi.useRealTimers();
      transfers.send([file('a.txt', [1, 2, 3, 4, 5]), file('b.bin', [9])]);
      expect(session!.offered.map((o) => [o.name, o.source.size])).toEqual([['a.txt', 5], ['b.bin', 1]]);
      expect([...(await session!.offered[0]!.source.read(1, 3))]).toEqual([2, 3, 4]);
      expect(cards()).toHaveLength(2);
      expect(card(0).classList.contains('outgoing')).toBe(true);
      expect(card(0).querySelector('.file-name')!.textContent).toBe('a.txt');
      expect(status()).toContain('chờ');
      expect(added).toEqual([false, false]);
    });

    test('progress shows percent and speed, throttled to about 4 updates per second', () => {
      transfers.send([file('big.bin', 'x'.repeat(1000))]);
      emit({ type: 'progress', id: 't1', bytes: 0, total: 1_000_000, direction: 'out' });
      expect(status()).toContain('0%');
      clock += 10;
      emit({ type: 'progress', id: 't1', bytes: 100_000, total: 1_000_000, direction: 'out' });
      clock += 10;
      emit({ type: 'progress', id: 't1', bytes: 200_000, total: 1_000_000, direction: 'out' });
      // Inside the 250 ms window: the screen still shows the first paint.
      expect(status()).toContain('0%');
      clock += PROGRESS_INTERVAL_MS;
      vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
      expect(status()).toContain('20%');
      expect(status()).toMatch(/\/s/);
      expect(card().querySelector<HTMLProgressElement>('progress')!.value).toBe(20);
    });

    test('completion, cancel and failure end the card; cancel asks the session', () => {
      transfers.send([file('a', 'abc'), file('b', 'abc'), file('c', 'abc')]);
      emit({ type: 'completed', id: 't1' });
      expect(status(0)).toBe('Đã gửi xong');
      expect(shown('file-cancel', 0)).toBe(false);
      button('file-cancel', 1).click();
      expect(session!.canceled).toEqual(['t2']);
      emit({ type: 'canceled', id: 't2' });
      expect(status(1)).toBe('Đã huỷ');
      emit({ type: 'failed', id: 't3', reason: FILE_IO_REASON });
      expect(status(2)).toBe('Lỗi: Không đọc hoặc lưu được file.');
      // A late event never revives a finished card.
      emit({ type: 'progress', id: 't1', bytes: 1, total: 3, direction: 'out' });
      expect(status(0)).toBe('Đã gửi xong');
    });

    test('files that cannot be offered get a failed card with a Vietnamese reason', () => {
      session!.sendError = new FileOfferError('invalidFileName');
      transfers.send([file('a', 'x')]);
      expect(status()).toContain('Tên file');
      session!.sendError = new FileTransferError('tooManyTransfers');
      transfers.send([file('b', 'x')]);
      expect(status(1)).toContain('16');
      session!.sendError = Object.assign(new Error('toolsUnavailable'), { name: 'RelaySessionError', code: 'toolsUnavailable' });
      transfers.send([file('c', 'x')]);
      expect(status(2)).toContain('kết nối');
      session = null;
      transfers.send([file('d', 'x')]);
      expect(status(3)).toContain('kết nối');
      expect(shown('file-cancel', 3)).toBe(false);
    });

    test('file names are rendered as text, never as markup', () => {
      transfers.send([file('<img src=x onerror=alert(1)>.txt', 'x')]);
      expect(card().querySelector('img')).toBeNull();
      expect(card().querySelector('.file-name')!.textContent).toBe('<img src=x onerror=alert(1)>.txt');
    });
  });

  describe('receiving', () => {
    test('an offer shows name, size, Save and Cancel, and counts as incoming', () => {
      offer('r1', 'report.pdf', 2048);
      expect(added).toEqual([true]);
      expect(card().querySelector('.file-name')!.textContent).toBe('report.pdf');
      expect(card().textContent).toContain('2,0 KiB');
      expect(button('file-save').textContent).toBe('Lưu');
      expect(button('file-save').disabled).toBe(false);
      expect(button('file-cancel').textContent).toBe('Huỷ');
      // The same offer twice is one card.
      offer('r1', 'report.pdf', 2048);
      expect(cards()).toHaveLength(1);
    });

    test('Save with File System Access: picker inside the click, accept with a streaming sink', async () => {
      const writable = new FakeWritable();
      let pickerCalledDuringClick = false;
      const picker = vi.fn(async (_o: { suggestedName: string }) => ({ createWritable: async () => writable }));
      win.showSaveFilePicker = picker;
      offer('r1', 'a/b:c.txt', 6);
      let inClick = true;
      button('file-save').addEventListener('click', () => {
        // Registered after the card's own listener, so the picker has already been asked.
        pickerCalledDuringClick = picker.mock.calls.length === 1 && inClick;
      });
      button('file-save').click();
      inClick = false;
      expect(pickerCalledDuringClick).toBe(true);
      expect(picker).toHaveBeenCalledWith({ suggestedName: 'a_b_c.txt' });
      expect(button('file-save').disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      const sink = session!.accepted.get('r1')!;
      expect(sink).toBeDefined();
      emit({ type: 'progress', id: 'r1', bytes: 0, total: 6, direction: 'in' });
      await sink.write(new Uint8Array([1, 2, 3]));
      await sink.write(new Uint8Array([4, 5, 6]));
      await sink.close();
      emit({ type: 'completed', id: 'r1' });
      expect(writable.bytes).toEqual([1, 2, 3, 4, 5, 6]);
      expect(writable.closed).toBe(1);
      expect(writable.aborted).toBe(0);
      expect(status()).toBe('Đã lưu xong');
      expect(downloads).toEqual([]);
    });

    test('a cancelled save dialog leaves the offer waiting; nothing is accepted', async () => {
      win.showSaveFilePicker = vi.fn(async () => {
        throw new DOMException('closed', 'AbortError');
      });
      offer('r1', 'a.txt', 3);
      button('file-save').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(session!.accepted.size).toBe(0);
      expect(button('file-save').disabled).toBe(false);
      expect(status()).not.toContain('Lỗi');
    });

    test('a failing picker or writable is reported on the card and the offer stays', async () => {
      win.showSaveFilePicker = vi.fn(async () => ({
        createWritable: async () => {
          throw new Error('denied');
        },
      }));
      offer('r1', 'a.txt', 3);
      button('file-save').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(session!.accepted.size).toBe(0);
      expect(card().textContent).toContain('Không mở được');
      expect(button('file-save').disabled).toBe(false);
    });

    test('the file chosen in the dialog is discarded when accept throws', async () => {
      const writable = new FakeWritable();
      win.showSaveFilePicker = async () => ({ createWritable: async () => writable });
      session!.acceptError = new FileTransferError('unavailableOffer');
      offer('r1', 'a.txt', 3);
      button('file-save').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(writable.aborted).toBe(1);
      expect(writable.closed).toBe(0);
      expect(status()).toContain('Lỗi');
      expect(shown('file-save')).toBe(false);
    });

    test('a host cancel while the dialog is open discards the chosen file and accepts nothing', async () => {
      const writable = new FakeWritable();
      let open!: (h: { createWritable: () => Promise<FakeWritable> }) => void;
      win.showSaveFilePicker = () => new Promise((r) => (open = r));
      offer('r1', 'a.txt', 3);
      button('file-save').click();
      emit({ type: 'canceled', id: 'r1' });
      open({ createWritable: async () => writable });
      await vi.advanceTimersByTimeAsync(0);
      expect(session!.accepted.size).toBe(0);
      expect(writable.aborted).toBe(1);
      expect(status()).toBe('Đã huỷ');
    });

    test('without File System Access the file is gathered in memory and downloaded on click under its own name', async () => {
      offer('r1', 'tài liệu.txt', 5);
      expect(button('file-save').disabled).toBe(false);
      button('file-save').click();
      await vi.advanceTimersByTimeAsync(0);
      const sink = session!.accepted.get('r1')!;
      emit({ type: 'progress', id: 'r1', bytes: 0, total: 5, direction: 'in' });
      await sink.write(new Uint8Array([1, 2]));
      await sink.write(new Uint8Array([3, 4, 5]));
      await sink.close();
      expect(downloads).toEqual([]);
      emit({ type: 'completed', id: 'r1' });
      // No download without a user gesture: the card offers a button instead.
      expect(downloads).toEqual([]);
      expect(urls).toEqual([]);
      expect(status()).toBe('Xong — bấm Tải về để lưu');
      expect(shown('file-download')).toBe(true);
      button('file-download').click();
      expect(downloads).toHaveLength(1);
      expect(downloads[0]!.name).toBe('tài liệu.txt');
      expect(downloads[0]!.href).toBe('blob:fake/1');
      expect(await bytesOf(urls[0]!)).toEqual([1, 2, 3, 4, 5]);
      // The blob is released after the click: the button goes away and cannot download again.
      expect(status()).toBe('Đã tải về');
      expect(shown('file-download')).toBe(false);
      button('file-download').click();
      expect(downloads).toHaveLength(1);
      expect(revoked).toEqual([]);
      vi.advanceTimersByTime(60_000);
      expect(revoked).toEqual(['blob:fake/1']);
      expect(document.querySelector('a[download]')).toBeNull();
    });

    test('a zero-byte file downloads an empty blob on click', async () => {
      offer('r1', 'empty.txt', 0);
      button('file-save').click();
      await vi.advanceTimersByTimeAsync(0);
      await session!.accepted.get('r1')!.close();
      emit({ type: 'completed', id: 'r1' });
      expect(downloads).toEqual([]);
      button('file-download').click();
      expect(downloads[0]!.name).toBe('empty.txt');
      expect(urls[0]!.size).toBe(0);
    });

    test('over 512 MiB without File System Access: Save is disabled with a reason, Cancel still works', () => {
      offer('big', 'movie.mkv', BLOB_LIMIT_BYTES + 1);
      expect(button('file-save').disabled).toBe(true);
      expect(card().textContent).toContain('512 MiB');
      button('file-save').click();
      expect(session!.accepted.size).toBe(0);
      button('file-cancel').click();
      expect(session!.canceled).toEqual(['big']);
    });

    test('exactly 512 MiB is allowed in memory, and a large file is allowed with File System Access', () => {
      offer('a', 'a', BLOB_LIMIT_BYTES);
      expect(button('file-save', 0).disabled).toBe(false);
      win.showSaveFilePicker = vi.fn();
      offer('b', 'b', BLOB_LIMIT_BYTES * 4);
      expect(button('file-save', 1).disabled).toBe(false);
    });

    test('Cancel on an offer tells the session; the card follows the canceled event', () => {
      offer('r1', 'a.txt', 3);
      button('file-cancel').click();
      expect(session!.canceled).toEqual(['r1']);
      emit({ type: 'canceled', id: 'r1' });
      expect(status()).toBe('Đã huỷ');
      expect(shown('file-save')).toBe(false);
    });

    test('failure reasons are translated', () => {
      offer('r1', 'a', 3);
      offer('r2', 'b', 3);
      offer('r3', 'c', 3);
      emit({ type: 'failed', id: 'r1', reason: FILE_INVALID_RANGE_REASON });
      emit({ type: 'failed', id: 'r2', reason: FILE_IO_REASON });
      emit({ type: 'failed', id: 'r3', reason: 'something unexpected' });
      expect(status(0)).toContain('sai vị trí');
      expect(status(1)).toContain('Không đọc hoặc lưu được');
      expect(status(2)).toBe('Lỗi: Truyền file không thành công.');
    });

    test('events for unknown ids are ignored', () => {
      emit({ type: 'progress', id: 'zzz', bytes: 1, total: 2, direction: 'in' });
      emit({ type: 'completed', id: 'zzz' });
      emit({ type: 'canceled', id: 'zzz' });
      expect(cards()).toHaveLength(0);
    });
  });

  describe('disconnect', () => {
    test('every running card becomes cancelled and nothing is downloaded', async () => {
      transfers.send([file('up.bin', 'abc')]);
      emit({ type: 'progress', id: 't1', bytes: 0, total: 3, direction: 'out' });
      offer('r1', 'waiting.txt', 4);
      offer('r2', 'running.txt', 4);
      button('file-save', 2).click();
      await vi.advanceTimersByTimeAsync(0);
      const sink = session!.accepted.get('r2')!;
      emit({ type: 'progress', id: 'r2', bytes: 0, total: 4, direction: 'in' });
      await sink.write(new Uint8Array([1, 2]));
      offer('r3', 'done.txt', 0);
      button('file-save', 3).click();
      await vi.advanceTimersByTimeAsync(0);
      await session!.accepted.get('r3')!.close();
      emit({ type: 'completed', id: 'r3' });
      downloads.length = 0;

      transfers.reset();
      expect(cards().map((c) => c.querySelector('.file-status')!.textContent)).toEqual(['Đã huỷ', 'Đã huỷ', 'Đã huỷ', 'Xong — bấm Tải về để lưu']);
      for (let i = 0; i < 4; i++) {
        expect(shown('file-save', i)).toBe(false);
        expect(shown('file-cancel', i)).toBe(false);
      }
      // A finished file stays downloadable after the disconnect.
      expect(shown('file-download', 3)).toBe(true);
      expect(downloads).toEqual([]);
      // The engine aborts the sink too; the blob sink then yields nothing.
      await sink.abort();
      expect((sink as BlobSink).take()).toBeNull();
    });

    test('a save dialog that was open at disconnect discards the chosen file afterwards', async () => {
      const writable = new FakeWritable();
      let open!: (h: { createWritable: () => Promise<FakeWritable> }) => void;
      win.showSaveFilePicker = () => new Promise((r) => (open = r));
      offer('r1', 'a.txt', 3);
      button('file-save').click();
      transfers.reset();
      open({ createWritable: async () => writable });
      await vi.advanceTimersByTimeAsync(0);
      expect(session!.accepted.size).toBe(0);
      expect(writable.aborted).toBe(1);
      expect(status()).toBe('Đã huỷ');
    });

    test('clear removes the old cards and releases an undownloaded file; a pending download URL is revoked on dispose', async () => {
      offer('r1', 'a.txt', 1);
      button('file-save').click();
      await vi.advanceTimersByTimeAsync(0);
      const sink = session!.accepted.get('r1')!;
      await sink.write(new Uint8Array([7]));
      await sink.close();
      emit({ type: 'completed', id: 'r1' });
      const waiting = card();
      const unclaimed = waiting.querySelector<HTMLButtonElement>('.file-download')!;
      transfers.clear();
      expect(cards()).toHaveLength(0);
      // Removed with its card: nothing is downloaded any more.
      unclaimed.click();
      expect(downloads).toEqual([]);
      expect(urls).toEqual([]);

      offer('r2', 'b.txt', 1);
      button('file-save').click();
      await vi.advanceTimersByTimeAsync(0);
      const second = session!.accepted.get('r2')!;
      await second.write(new Uint8Array([7]));
      await second.close();
      emit({ type: 'completed', id: 'r2' });
      button('file-download').click();
      transfers.dispose();
      expect(revoked).toEqual(['blob:fake/1']);
    });
  });

  describe('sinks', () => {
    test('blob sink: abort after close keeps a complete result, close after abort is a safe no-op', async () => {
      const kept = new BlobSink();
      await kept.write(new Uint8Array([1, 2]));
      await kept.close();
      await expect(kept.abort()).resolves.toBeUndefined();
      expect(await bytesOf(kept.take()!)).toEqual([1, 2]);

      const dropped = new BlobSink();
      await dropped.write(new Uint8Array([1, 2]));
      await dropped.abort();
      await expect(dropped.close()).resolves.toBeUndefined();
      expect(dropped.take()).toBeNull();
      await expect(dropped.write(new Uint8Array([3]))).rejects.toThrow();
      await expect(dropped.abort()).resolves.toBeUndefined();
    });

    test('blob sink refuses to grow past its limit', async () => {
      const sink = new BlobSink(10);
      await sink.write(new Uint8Array(10));
      await expect(sink.write(new Uint8Array(1))).rejects.toThrow();
    });

    test('blob sink copies what it is given', async () => {
      const sink = new BlobSink();
      const chunk = new Uint8Array([1, 2, 3]);
      await sink.write(chunk);
      chunk.fill(0);
      await sink.close();
      expect(await bytesOf(sink.take()!)).toEqual([1, 2, 3]);
    });

    test('file sink: abort after close and close after abort never throw or corrupt', async () => {
      const done = new FakeWritable();
      const committed = new FsSink(done);
      await committed.write(new Uint8Array([1]));
      await committed.close();
      await expect(committed.abort()).resolves.toBeUndefined();
      await expect(committed.close()).resolves.toBeUndefined();
      expect(done.closed).toBe(1);
      expect(done.aborted).toBe(0);

      const partial = new FakeWritable();
      const cancelled = new FsSink(partial);
      await cancelled.write(new Uint8Array([1]));
      await cancelled.abort();
      await expect(cancelled.close()).resolves.toBeUndefined();
      await expect(cancelled.abort()).resolves.toBeUndefined();
      await expect(cancelled.write(new Uint8Array([2]))).rejects.toThrow();
      expect(partial.closed).toBe(0);
      expect(partial.aborted).toBe(1);
    });

    test('file sink: a failed close discards the partial file on abort, and a failing abort is swallowed', async () => {
      const w = new FakeWritable();
      w.close = async () => {
        throw new Error('disk full');
      };
      w.abort = async () => {
        w.aborted++;
        throw new Error('already errored');
      };
      const sink = new FsSink(w);
      await expect(sink.close()).rejects.toThrow();
      await expect(sink.abort()).resolves.toBeUndefined();
      expect(w.aborted).toBe(1);
    });
  });

  describe('drop zone', () => {
    let target: HTMLElement;
    let dropped: File[][];
    let enabled: boolean;
    let detach: () => void;

    const drag = (type: string, types: string[] = ['Files'], files: File[] = []): Event => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
      target.dispatchEvent(e);
      return e;
    };
    const overlay = () => target.querySelector<HTMLElement>('.drop-overlay')!;

    beforeEach(() => {
      document.body.innerHTML = '<div id="t"></div>';
      target = document.getElementById('t')!;
      dropped = [];
      enabled = true;
      detach = attachDropZone(target, { enabled: () => enabled, hint: 'Thả file', onFiles: (f) => dropped.push(f) });
    });

    test('dragging files over shows the overlay; leaving hides it; drop delivers the files and is cancelled', () => {
      expect(overlay().hidden).toBe(true);
      const over = drag('dragenter');
      expect(over.defaultPrevented).toBe(true);
      expect(overlay().hidden).toBe(false);
      expect(overlay().textContent).toBe('Thả file');
      drag('dragenter');
      drag('dragleave');
      expect(overlay().hidden).toBe(false);
      drag('dragleave');
      expect(overlay().hidden).toBe(true);
      drag('dragenter');
      const f = file('a.txt', 'x');
      const drop = drag('drop', ['Files'], [f]);
      expect(drop.defaultPrevented).toBe(true);
      expect(overlay().hidden).toBe(true);
      expect(dropped).toEqual([[f]]);
    });

    test('drags that are not files are left alone', () => {
      expect(drag('dragover', ['text/plain']).defaultPrevented).toBe(false);
      expect(drag('drop', ['text/plain']).defaultPrevented).toBe(false);
      expect(overlay().hidden).toBe(true);
      expect(dropped).toEqual([]);
    });

    test('while disabled a dropped file is swallowed (no navigation) but not sent', () => {
      enabled = false;
      expect(drag('dragenter').defaultPrevented).toBe(true);
      expect(overlay().hidden).toBe(true);
      expect(drag('drop', ['Files'], [file('a', 'x')]).defaultPrevented).toBe(true);
      expect(dropped).toEqual([]);
    });

    test('detach removes the overlay and the listeners', () => {
      detach();
      expect(target.querySelector('.drop-overlay')).toBeNull();
      expect(drag('drop', ['Files'], [file('a', 'x')]).defaultPrevented).toBe(false);
    });
  });
});
