// Port of UltraViewerProtocol/FileTransferEngine.swift (viewer role) plus the fileOutbox of
// UltraViewerRelaySession.swift (sendFile/acceptFile/cancelFile, 981-1031). The Swift engine is
// synchronous and writes to disk; here reading the source and writing the sink are async and
// abstract (FileSource wraps File.slice, FileSink wraps File System Access or a Blob), so:
//  - every outgoing message goes through ONE serialized outbox (chunk order is preserved, and a
//    slow source.read never sits in front of chat/input sends, which do not use the outbox);
//  - incoming messages are processed in order per transfer id (a slow sink.write only delays that
//    transfer), and a chunk is copied on entry because the decoder hands out a view into the
//    multipart buffer.
// File names and contents never reach a log; only transfer ids appear in events.
import type { RemoteMessage } from '../proto/commands';
import {
  MAX_FILE_PART_SIZE,
  fileAcceptPayload,
  fileAckPayload,
  fileCancelPayload,
  fileChunkPayload,
  fileOfferPayload,
  newTransferId,
  type FileMessage,
} from '../proto/file-offer';

/** Swift `maximumTransfers`: incoming + outgoing transfers alive at once. */
export const MAX_FILE_TRANSFERS = 16;
/** Swift `partsInFlight`: chunks sent but not yet acknowledged. */
export const FILE_PARTS_IN_FLIGHT = 2;

/** Swift failure strings, verbatim (the UI translates them). */
export const FILE_INVALID_RANGE_REASON = 'The file contained an invalid data offset or length.';
export const FILE_IO_REASON = 'The file could not be read or saved.';

/** `0`-based random access over the file being sent; wraps `File.slice(...).arrayBuffer()`. */
export interface FileSource {
  size: number;
  read(offset0: number, length: number): Promise<Uint8Array>;
}

/** Where received bytes go. `close` finalizes the file, `abort` discards a partial one. */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export type FileEvent =
  | { type: 'incoming'; id: string; name: string; size: number }
  | { type: 'progress'; id: string; bytes: number; total: number; direction: 'in' | 'out' }
  | { type: 'completed'; id: string }
  | { type: 'canceled'; id: string }
  | { type: 'failed'; id: string; reason: string };

export type FileTransferErrorCode = 'tooManyTransfers' | 'unavailableOffer';

/** Swift `Failure` (tooManyTransfers / unavailableOffer); invalid names/sizes raise FileOfferError. */
export class FileTransferError extends Error {
  readonly code: FileTransferErrorCode;
  constructor(code: FileTransferErrorCode) {
    super(code);
    this.name = 'FileTransferError';
    this.code = code;
  }
}

interface Incoming {
  readonly size: number;
  sink: FileSink | null;
  received: number;
}

interface Outgoing {
  readonly id: string;
  readonly source: FileSource;
  readonly size: number;
  accepted: boolean;
  /** One-based offset of the next chunk. */
  nextOffset: number;
  acknowledged: number;
  inFlight: number[];
  filling: boolean;
}

interface Queued {
  id: string;
  message: RemoteMessage;
  resolve(): void;
  reject(error: unknown): void;
}

const noop = (): void => {};

/** Run a sink callback; a throw or rejection is swallowed (cleanup must never break the engine). */
function quiet(fn: () => Promise<void>): void {
  try {
    fn().catch(noop);
  } catch {
    // Ignored on purpose.
  }
}

export class FileTransferEngine {
  private readonly incoming = new Map<string, Incoming>();
  private readonly outgoing = new Map<string, Outgoing>();
  private listener: (event: FileEvent) => void = noop;
  private outbox: Queued[] = [];
  private draining = false;
  private revision = 0;
  /** Bumped by reset(): inbound work queued before it must not touch a later transfer. */
  private epoch = 0;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly send: (message: RemoteMessage) => Promise<void>) {}

  /** Transfers alive right now (Swift `count`). */
  get count(): number {
    return this.incoming.size + this.outgoing.size;
  }

  onEvent(cb: (event: FileEvent) => void): void {
    this.listener = cb;
  }

  /**
   * Swift offerFile: registers an outgoing transfer and queues the offer; data is read only after
   * the host accepts. Throws FileOfferError (invalid name/size) or FileTransferError(tooManyTransfers).
   */
  offer(name: string, source: FileSource): string {
    if (this.count >= MAX_FILE_TRANSFERS) throw new FileTransferError('tooManyTransfers');
    let id: string;
    do id = newTransferId();
    while (this.incoming.has(id) || this.outgoing.has(id));
    const message = fileOfferPayload(id, name, source.size);
    const file: Outgoing = { id, source, size: source.size, accepted: false, nextOffset: 1, acknowledged: 0, inFlight: [], filling: false };
    this.outgoing.set(id, file);
    this.postQuiet(id, message, () => {
      if (this.outgoing.get(id) === file) this.fail(id, FILE_IO_REASON);
    });
    return id;
  }

  /** Swift accept: the caller has chosen where the file goes. A second accept of the same offer is a no-op. */
  async accept(id: string, sink: FileSink): Promise<void> {
    const file = this.incoming.get(id);
    if (file === undefined) throw new FileTransferError('unavailableOffer');
    if (file.sink !== null) return;
    file.sink = sink;
    this.emit({ type: 'progress', id, bytes: 0, total: file.size, direction: 'in' });
    if (file.size === 0) {
      try {
        await sink.close();
      } catch {
        if (this.incoming.get(id) === file) this.fail(id, FILE_IO_REASON);
        return;
      }
      if (this.incoming.get(id) !== file) return;
      this.incoming.delete(id);
      this.emit({ type: 'completed', id });
      await this.post(id, fileAcceptPayload(id));
      return;
    }
    try {
      await this.post(id, fileAcceptPayload(id));
    } catch (e) {
      if (this.incoming.get(id) === file) this.discard(id); // Swift: acceptFile cancels locally and rethrows.
      throw e;
    }
  }

  /** Swift cancel: unknown ids are ignored; otherwise abort locally, emit `canceled` and tell the host. */
  async cancel(id: string): Promise<void> {
    if (!this.incoming.has(id) && !this.outgoing.has(id)) return;
    this.discard(id);
    this.emit({ type: 'canceled', id });
    await this.post(id, fileCancelPayload(id));
  }

  /**
   * Swift consume: one decoded host message. The returned promise settles when the message has
   * been applied (sends it triggers are queued, not awaited). Never rejects.
   */
  handle(message: FileMessage): Promise<void> {
    const copy: FileMessage = message.type === 'chunk' ? { ...message, data: message.data.slice() } : message;
    const epoch = this.epoch;
    const previous = this.chains.get(copy.id) ?? Promise.resolve();
    const next = previous
      .then(() => (epoch === this.epoch ? this.apply(copy) : undefined))
      .catch(noop);
    this.chains.set(copy.id, next);
    void next.then(() => {
      if (this.chains.get(copy.id) === next) this.chains.delete(copy.id);
    });
    return next;
  }

  /** Swift reset: the connection ended. Every transfer is aborted (`canceled`), nothing more is sent. */
  reset(): void {
    this.epoch++;
    this.revision++;
    this.draining = false;
    const dropped = this.outbox;
    this.outbox = [];
    for (const item of dropped) item.resolve();
    for (const id of [...this.incoming.keys(), ...this.outgoing.keys()]) {
      this.discard(id);
      this.emit({ type: 'canceled', id });
    }
  }

  // --- inbound -----------------------------------------------------------

  private async apply(message: FileMessage): Promise<void> {
    const id = message.id;
    switch (message.type) {
      case 'offer':
        // A repeated offer must not overwrite an accepted sink or an outgoing transfer with the same id.
        if (this.incoming.has(id) || this.outgoing.has(id)) return;
        if (this.count >= MAX_FILE_TRANSFERS) {
          this.postQuiet(id, fileCancelPayload(id));
          return;
        }
        this.incoming.set(id, { size: message.size, sink: null, received: 0 });
        this.emit({ type: 'incoming', id, name: message.name, size: message.size });
        return;
      case 'accept': {
        const file = this.outgoing.get(id);
        if (message.offset !== 1 || file === undefined || file.accepted) return;
        file.accepted = true;
        if (file.size === 0) {
          this.outgoing.delete(id);
          this.emit({ type: 'completed', id });
          return;
        }
        this.emit({ type: 'progress', id, bytes: 0, total: file.size, direction: 'out' });
        void this.fill(file);
        return;
      }
      case 'ack': {
        const file = this.outgoing.get(id);
        if (file === undefined || !file.accepted || file.inFlight.length === 0) return;
        file.acknowledged += file.inFlight.shift()!;
        this.emit({ type: 'progress', id, bytes: file.acknowledged, total: file.size, direction: 'out' });
        if (file.acknowledged === file.size) {
          this.outgoing.delete(id);
          this.emit({ type: 'completed', id });
        } else {
          void this.fill(file);
        }
        return;
      }
      case 'chunk':
        await this.receiveChunk(id, message.offset, message.data);
        return;
      case 'cancel':
        if (!this.incoming.has(id) && !this.outgoing.has(id)) return;
        this.discard(id);
        this.emit({ type: 'canceled', id });
        return;
    }
  }

  private async receiveChunk(id: string, offset: number, data: Uint8Array): Promise<void> {
    const file = this.incoming.get(id);
    const sink = file?.sink;
    if (file === undefined || sink === null || sink === undefined) return;
    if (offset !== file.received + 1 || data.length === 0 || data.length > MAX_FILE_PART_SIZE || data.length > file.size - file.received) {
      this.fail(id, FILE_INVALID_RANGE_REASON);
      return;
    }
    try {
      await sink.write(data);
    } catch {
      if (this.incoming.get(id) === file) this.fail(id, FILE_IO_REASON);
      return;
    }
    if (this.incoming.get(id) !== file) return;
    file.received += data.length;
    this.emit({ type: 'progress', id, bytes: file.received, total: file.size, direction: 'in' });
    if (file.received === file.size) {
      try {
        await sink.close();
      } catch {
        if (this.incoming.get(id) === file) this.fail(id, FILE_IO_REASON);
        return;
      }
      if (this.incoming.get(id) !== file) return;
      this.incoming.delete(id);
      this.emit({ type: 'completed', id });
    }
    this.postQuiet(id, fileAckPayload(id));
  }

  // --- outbound ----------------------------------------------------------

  /** Swift fillWindow: read and queue chunks until two are unacknowledged; one reader per transfer. */
  private async fill(file: Outgoing): Promise<void> {
    if (file.filling) return;
    file.filling = true;
    const current = (): boolean => this.outgoing.get(file.id) === file;
    try {
      while (current() && file.accepted && file.inFlight.length < FILE_PARTS_IN_FLIGHT && file.nextOffset <= file.size) {
        const length = Math.min(MAX_FILE_PART_SIZE, file.size - file.nextOffset + 1);
        const bytes = await file.source.read(file.nextOffset - 1, length);
        if (!current()) return;
        // A changed/truncated source must fail; never send bytes beyond the size the host accepted.
        if (bytes.length !== length) throw new Error('short read');
        const message = fileChunkPayload(file.id, file.nextOffset, bytes);
        file.nextOffset += length;
        file.inFlight.push(length);
        this.postQuiet(file.id, message, () => {
          if (current()) this.fail(file.id, FILE_IO_REASON);
        });
      }
    } catch {
      if (current()) this.fail(file.id, FILE_IO_REASON);
    } finally {
      file.filling = false;
    }
  }

  private post(id: string, message: RemoteMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.outbox.push({ id, message, resolve, reject });
      void this.drain();
    });
  }

  private postQuiet(id: string, message: RemoteMessage, onError: () => void = noop): void {
    this.post(id, message).catch(onError);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const revision = this.revision;
    try {
      while (this.revision === revision && this.outbox.length > 0) {
        const item = this.outbox.shift()!;
        try {
          await this.send(item.message);
          item.resolve();
        } catch (e) {
          item.reject(e);
        }
      }
    } finally {
      if (this.revision === revision) this.draining = false;
    }
  }

  // --- shared ------------------------------------------------------------

  private fail(id: string, reason: string): void {
    this.discard(id);
    this.emit({ type: 'failed', id, reason });
    this.postQuiet(id, fileCancelPayload(id));
  }

  /** Swift discard: forget the transfer, abort a partial incoming file, drop its unsent messages. */
  private discard(id: string): void {
    this.outgoing.delete(id);
    const file = this.incoming.get(id);
    if (file !== undefined) {
      this.incoming.delete(id);
      const sink = file.sink;
      if (sink !== null) quiet(() => sink.abort());
    }
    const kept: Queued[] = [];
    for (const item of this.outbox) {
      if (item.id === id) item.resolve();
      else kept.push(item);
    }
    this.outbox = kept;
  }

  private emit(event: FileEvent): void {
    try {
      this.listener(event);
    } catch {
      // A throwing listener must not corrupt the state machine.
    }
  }
}
