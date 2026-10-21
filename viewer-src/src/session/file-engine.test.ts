import { describe, expect, test } from 'vitest';
import type { RemoteMessage } from '../proto/commands';
import { FileOfferError, decodeFileMessage } from '../proto/file-offer';
import { concat, enc, u8 } from '../proto/test-utils';
import {
  FILE_INVALID_RANGE_REASON,
  FILE_IO_REASON,
  FileTransferEngine,
  FileTransferError,
  MAX_FILE_TRANSFERS,
  type FileEvent,
  type FileSink,
  type FileSource,
} from './file-engine';

// Ported from FileTransferEngineTests.swift: the web viewer is always the viewer role, so the host
// side is played by the test (multipart messages in, raw/UTF-16 payloads out).

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const utf16 = (m: RemoteMessage): string => new TextDecoder('utf-16le').decode(m.bytes);

function dbl(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, true);
  return out;
}

const hostOffer = (id: string, name: string, size: number) => decodeFileMessage([u8(13, 0), enc(id), enc(name), dbl(size)])!;
const hostChunk = (id: string, offset: number, data: Uint8Array) => decodeFileMessage([u8(15, 0), enc(id), dbl(offset), data])!;
const hostAccept = (id: string) => decodeFileMessage([u8(14, 0), enc(id), u8(1, 0, 0, 0)])!;
const hostAck = (id: string) => decodeFileMessage([u8(21, 0), enc(id)])!;
const hostCancel = (id: string) => decodeFileMessage([u8(16, 0), enc(id)])!;

/** The viewer's raw chunk payload `15|||id|||offset|||data` → its parts. */
function parseChunk(m: RemoteMessage): { id: string; offset: number; data: Uint8Array } {
  expect(m.formatFlag).toBe(false);
  const bars: number[] = [];
  for (let i = 0; i + 2 < m.bytes.length && bars.length < 3; i++) {
    if (m.bytes[i] === 0x7c && m.bytes[i + 1] === 0x7c && m.bytes[i + 2] === 0x7c) {
      bars.push(i);
      i += 2;
    }
  }
  expect(bars).toHaveLength(3);
  const text = new TextDecoder().decode(m.bytes.subarray(0, bars[2]! + 3));
  const [command, id, offset] = text.split('|||');
  expect(command).toBe('15');
  return { id: id!, offset: Number(offset), data: m.bytes.slice(bars[2]! + 3) };
}

class MemorySource implements FileSource {
  readonly reads: { offset0: number; length: number }[] = [];
  gate: Promise<void> | null = null;
  fail = false;
  short = false;
  constructor(readonly bytes: Uint8Array) {}
  get size(): number {
    return this.bytes.length;
  }
  async read(offset0: number, length: number): Promise<Uint8Array> {
    this.reads.push({ offset0, length });
    if (this.gate) await this.gate;
    if (this.fail) throw new Error('read failed');
    const out = this.bytes.slice(offset0, offset0 + length);
    return this.short ? out.slice(0, Math.max(0, out.length - 1)) : out;
  }
}

class MemorySink implements FileSink {
  readonly chunks: Uint8Array[] = [];
  closed = false;
  aborted = false;
  failWrite = false;
  failClose = false;
  gate: Promise<void> | null = null;
  async write(chunk: Uint8Array): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failWrite) throw new Error('disk full');
    this.chunks.push(chunk);
  }
  async close(): Promise<void> {
    if (this.failClose) throw new Error('close failed');
    this.closed = true;
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
  get bytes(): Uint8Array {
    return concat(...this.chunks);
  }
}

function setup() {
  const sent: RemoteMessage[] = [];
  const events: FileEvent[] = [];
  const state = { sendGate: null as Promise<void> | null, sendFails: false };
  const engine = new FileTransferEngine(async (m) => {
    if (state.sendGate) await state.sendGate;
    if (state.sendFails) throw new Error('not connected');
    sent.push(m);
  });
  engine.onEvent((e) => events.push(e));
  const texts = () => sent.filter((m) => m.formatFlag).map(utf16);
  return { engine, sent, events, state, texts };
}

/** 128,017 bytes with `|||`, NUL and 0xC3 0xBF straddling the 32,000-byte part boundary. */
function fixture(): Uint8Array {
  const bytes = Uint8Array.from({ length: 128_017 }, (_, i) => i & 255);
  bytes.set([0x7c, 0x7c, 0x7c, 0, 0x7c, 0x7c, 0x7c, 0xc3, 0xbf], 31_995);
  return bytes;
}

describe('FileTransferEngine (FileTransferEngineTests.swift)', () => {
  test('receives exact arbitrary bytes from the host; nothing is written before accept', async () => {
    const { engine, sent, events, texts } = setup();
    const bytes = fixture();
    const id = '30121899004712353684';
    await engine.handle(hostOffer(id, 'Bao cao.bin', bytes.length));
    expect(events).toEqual([{ type: 'incoming', id, name: 'Bao cao.bin', size: 128_017 }]);
    // A chunk before the user chose a destination is ignored.
    await engine.handle(hostChunk(id, 1, bytes.slice(0, 1)));
    await flush();
    expect(sent).toEqual([]);
    const sink = new MemorySink();
    await engine.accept(id, sink);
    expect(texts()).toEqual([`14|||${id}|||1`]);
    expect(sent[0]!.formatFlag).toBe(true);
    let maxPart = 0;
    for (let offset = 0; offset < bytes.length; offset += 32_000) {
      const part = bytes.slice(offset, offset + 32_000);
      maxPart = Math.max(maxPart, part.length);
      await engine.handle(hostChunk(id, offset + 1, part));
      await flush();
    }
    expect(maxPart).toBe(32_000);
    expect(texts()).toEqual([`14|||${id}|||1`, ...[1, 2, 3, 4, 5].map(() => `21|||${id}`)]);
    expect(sink.bytes).toEqual(bytes);
    expect(sink.closed).toBe(true);
    expect(sink.aborted).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'completed', id });
    expect(events.filter((e) => e.type === 'progress').map((e) => (e.type === 'progress' ? e.bytes : -1))).toEqual([0, 32_000, 64_000, 96_000, 128_000, 128_017]);
    expect(events.filter((e) => e.type === 'progress').every((e) => e.type === 'progress' && e.direction === 'in' && e.total === 128_017)).toBe(true);
    expect(engine.count).toBe(0);
  });

  test('sends exact arbitrary bytes to the host in 32,000-byte parts', async () => {
    const { engine, sent, events, texts } = setup();
    const bytes = fixture();
    const source = new MemorySource(bytes);
    const id = engine.offer('Báo cáo 日本語 😀.bin', source);
    expect(id).toMatch(/^3\d{19}$/);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.formatFlag).toBe(true);
    expect(texts()).toEqual([`13|||${id}|||Báo cáo 日本語 😀.bin|||128017`]);
    expect(source.reads).toEqual([]);
    // An ack before accept is ignored.
    await engine.handle(hostAck(id));
    await flush();
    expect(sent).toHaveLength(1);
    await engine.handle(hostAccept(id));
    await flush();
    const chunks: { id: string; offset: number; data: Uint8Array }[] = sent.slice(1).map(parseChunk);
    expect(chunks.map((c) => c.offset)).toEqual([1, 32_001]);
    let completed = false;
    let guard = 0;
    while (!events.some((e) => e.type === 'completed')) {
      expect(++guard).toBeLessThan(100);
      await engine.handle(hostAck(id));
      await flush();
      completed = events.some((e) => e.type === 'completed');
      chunks.splice(0, chunks.length, ...sent.slice(1).map(parseChunk));
    }
    expect(completed).toBe(true);
    expect(chunks.map((c) => c.offset)).toEqual([1, 32_001, 64_001, 96_001, 128_001]);
    expect(Math.max(...chunks.map((c) => c.data.length))).toBe(32_000);
    expect(chunks.every((c) => c.id === id)).toBe(true);
    expect(concat(...chunks.map((c) => c.data))).toEqual(bytes);
    expect(events.at(-1)).toEqual({ type: 'completed', id });
    expect(engine.count).toBe(0);
  });

  test('ack flow control caps the window; a duplicate accept sends nothing extra', async () => {
    const { engine, sent, events } = setup();
    const source = new MemorySource(new Uint8Array(200_000));
    const id = engine.offer('source', source);
    await flush();
    await engine.handle(hostAccept(id));
    await flush();
    expect(sent.slice(1)).toHaveLength(2);
    await engine.handle(hostAccept(id));
    await flush();
    expect(sent.slice(1)).toHaveLength(2);
    expect(events).toEqual([{ type: 'progress', id, bytes: 0, total: 200_000, direction: 'out' }]);
    await engine.handle(hostAck(id));
    await flush();
    expect(sent.slice(1)).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: 'progress', id, bytes: 32_000, total: 200_000, direction: 'out' });
    expect(source.reads.map((r) => r.offset0)).toEqual([0, 32_000, 64_000]);
    engine.reset();
  });

  test('zero-byte files complete after acceptance in both directions', async () => {
    const { engine, sent, events, texts } = setup();
    const sink = new MemorySink();
    await engine.handle(hostOffer('123', 'empty', 0));
    await engine.accept('123', sink);
    expect(texts()).toEqual(['14|||123|||1']);
    expect(sink.closed).toBe(true);
    expect(sink.bytes).toEqual(new Uint8Array(0));
    expect(events).toContainEqual({ type: 'completed', id: '123' });
    const source = new MemorySource(new Uint8Array(0));
    const id = engine.offer('empty', source);
    await flush();
    await engine.handle(hostAccept(id));
    await flush();
    expect(events.at(-1)).toEqual({ type: 'completed', id });
    expect(source.reads).toEqual([]);
    expect(sent).toHaveLength(2); // accept + offer, no chunk
    expect(engine.count).toBe(0);
  });

  test('gaps, repeated offsets, overrun and oversized parts fail the transfer with the Swift string', async () => {
    const cases: [number, Uint8Array][] = [
      [2, u8(1)],
      [1, u8(1, 2, 3, 4)],
      [1, new Uint8Array(32_001)],
      [1, new Uint8Array(0)],
    ];
    for (const [offset, data] of cases) {
      const { engine, events, texts } = setup();
      const sink = new MemorySink();
      await engine.handle(hostOffer('123', 'a', 3));
      await engine.accept('123', sink);
      await engine.handle({ type: 'chunk', id: '123', offset, data });
      await flush();
      expect(events.at(-1)).toEqual({ type: 'failed', id: '123', reason: FILE_INVALID_RANGE_REASON });
      expect(FILE_INVALID_RANGE_REASON).toBe('The file contained an invalid data offset or length.');
      expect(texts().at(-1)).toBe('16|||123');
      expect(texts()).not.toContain('21|||123');
      expect(sink.aborted).toBe(true);
      expect(sink.closed).toBe(false);
      expect(events.some((e) => e.type === 'completed')).toBe(false);
      expect(engine.count).toBe(0);
    }
    const { engine, events, texts } = setup();
    const sink = new MemorySink();
    await engine.handle(hostOffer('123', 'a', 3));
    await engine.accept('123', sink);
    await engine.handle(hostChunk('123', 1, u8(1)));
    await engine.handle(hostChunk('123', 1, u8(1)));
    await flush();
    expect(events.at(-1)).toMatchObject({ type: 'failed', reason: FILE_INVALID_RANGE_REASON });
    expect(texts()).toEqual(['14|||123|||1', '21|||123', '16|||123']);
    expect(sink.aborted).toBe(true);
  });

  test('duplicate offers keep the accepted state; a 17th transfer is canceled', async () => {
    const { engine, events, texts } = setup();
    const sink = new MemorySink();
    await engine.handle(hostOffer('123', 'a.txt', 3));
    await engine.accept('123', sink);
    await engine.handle(hostOffer('123', 'a.txt', 3));
    expect(events.filter((e) => e.type === 'incoming')).toHaveLength(1);
    await engine.handle(hostChunk('123', 1, u8(1, 2, 3)));
    await flush();
    expect(sink.bytes).toEqual(u8(1, 2, 3));
    expect(events).toContainEqual({ type: 'completed', id: '123' });

    const e2 = setup();
    for (let i = 0; i < MAX_FILE_TRANSFERS; i++) await e2.engine.handle(hostOffer(`${i}`, 'a', 3));
    expect(e2.engine.count).toBe(16);
    await e2.engine.handle(hostOffer('extra', 'a', 3));
    await flush();
    expect(e2.texts()).toEqual(['16|||extra']);
    expect(e2.events.filter((e) => e.type === 'incoming')).toHaveLength(16);
    expect(e2.engine.count).toBe(16);
    e2.engine.reset();
    expect(texts()).toEqual(['14|||123|||1', '21|||123']);
  });

  test('an outgoing offer counts toward the 16 transfers and a host offer cannot reuse its id', async () => {
    const { engine, events } = setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_FILE_TRANSFERS; i++) ids.push(engine.offer('f', new MemorySource(new Uint8Array(3))));
    expect(() => engine.offer('f', new MemorySource(new Uint8Array(3)))).toThrowError(expect.objectContaining({ name: 'FileTransferError', code: 'tooManyTransfers' }));
    await engine.handle(hostOffer(ids[0]!, 'x', 3));
    expect(events).toEqual([]);
    engine.reset();
  });

  test('offer and accept validate before anything is sent', async () => {
    const { engine, sent } = setup();
    expect(() => engine.offer('a|||b', new MemorySource(new Uint8Array(1)))).toThrowError(expect.objectContaining({ name: 'FileOfferError', code: 'invalidFileName' }));
    expect(() => engine.offer('', new MemorySource(new Uint8Array(1)))).toThrow(FileOfferError);
    expect(() => engine.offer('a', { size: 1.5, read: async () => new Uint8Array(0) })).toThrowError(expect.objectContaining({ code: 'invalidSize' }));
    await expect(engine.accept('nope', new MemorySink())).rejects.toBeInstanceOf(FileTransferError);
    await expect(engine.accept('nope', new MemorySink())).rejects.toMatchObject({ code: 'unavailableOffer' });
    await flush();
    expect(sent).toEqual([]);
    expect(engine.count).toBe(0);
  });

  test('disconnect mid-transfer aborts sinks, emits canceled, and nothing is sent afterwards', async () => {
    const { engine, sent, events } = setup();
    const sink = new MemorySink();
    await engine.handle(hostOffer('123', 'a', 100_000));
    await engine.accept('123', sink);
    await engine.handle(hostChunk('123', 1, new Uint8Array(32_000)));
    await engine.handle(hostOffer('456', 'b', 10)); // never accepted: no sink to abort
    const source = new MemorySource(new Uint8Array(200_000));
    const out = engine.offer('c', source);
    await flush();
    await engine.handle(hostAccept(out));
    await flush();
    const sentBefore = sent.length;
    engine.reset();
    await flush();
    expect(sink.aborted).toBe(true);
    expect(sink.closed).toBe(false);
    const canceled = events.filter((e) => e.type === 'canceled').map((e) => (e.type === 'canceled' ? e.id : ''));
    expect(canceled.sort()).toEqual(['123', '456', out].sort());
    expect(engine.count).toBe(0);
    // Late host messages and queued work do nothing.
    await engine.handle(hostAck(out));
    await engine.handle(hostChunk('123', 32_001, new Uint8Array(10)));
    await flush();
    expect(sent).toHaveLength(sentBefore);
  });

  test('a read that finishes after the disconnect sends nothing and starts nothing', async () => {
    const { engine, sent, events } = setup();
    const source = new MemorySource(new Uint8Array(200_000));
    let release = () => {};
    source.gate = new Promise<void>((resolve) => (release = resolve));
    const id = engine.offer('slow', source);
    await flush();
    await engine.handle(hostAccept(id));
    await flush();
    expect(source.reads).toHaveLength(1);
    engine.reset();
    release();
    await flush();
    expect(sent).toHaveLength(1); // just the offer
    expect(source.reads).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'canceled', id });
  });

  test('a slow source.read does not block acks of another transfer', async () => {
    const { engine, texts } = setup();
    const slow = new MemorySource(new Uint8Array(100_000));
    slow.gate = new Promise<void>(() => {});
    const id = engine.offer('slow', slow);
    await flush();
    await engine.handle(hostAccept(id));
    await engine.handle(hostOffer('777', 'in', 3));
    await engine.accept('777', new MemorySink());
    await engine.handle(hostChunk('777', 1, u8(1, 2, 3)));
    await flush();
    expect(texts().slice(-2)).toEqual(['14|||777|||1', '21|||777']);
    engine.reset();
  });

  test('outgoing messages are serialized in order even when the send is slow', async () => {
    const { engine, sent, state } = setup();
    let release = () => {};
    state.sendGate = new Promise<void>((resolve) => (release = resolve));
    await engine.handle(hostOffer('1', 'a', 3));
    await engine.handle(hostOffer('2', 'a', 3));
    await engine.handle(hostOffer('3', 'a', 3));
    const sinks = [new MemorySink(), new MemorySink(), new MemorySink()];
    void engine.accept('1', sinks[0]!);
    void engine.accept('2', sinks[1]!);
    void engine.accept('3', sinks[2]!);
    await flush();
    expect(sent).toEqual([]);
    release();
    await flush();
    expect(sent.map(utf16)).toEqual(['14|||1|||1', '14|||2|||1', '14|||3|||1']);
  });

  test('cancel: local cancel aborts, tells the host and drops queued chunks; remote cancel is silent', async () => {
    const { engine, sent, events, state, texts } = setup();
    const sink = new MemorySink();
    await engine.handle(hostOffer('123', 'a', 10));
    await engine.accept('123', sink);
    await engine.cancel('123');
    expect(sink.aborted).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'canceled', id: '123' });
    expect(texts()).toEqual(['14|||123|||1', '16|||123']);
    await engine.cancel('123'); // unknown now: nothing
    await engine.cancel('unknown');
    expect(sent).toHaveLength(2);

    // Queued (unsent) chunks of a canceled outgoing transfer are removed from the outbox.
    const source = new MemorySource(new Uint8Array(200_000));
    const id = engine.offer('f', source);
    await flush();
    let release = () => {};
    state.sendGate = new Promise<void>((resolve) => (release = resolve));
    await engine.handle(hostAccept(id));
    await flush();
    // The first chunk is inside the blocked send; the second is still queued behind it.
    const before = sent.length;
    const canceling = engine.cancel(id);
    expect(events.at(-1)).toEqual({ type: 'canceled', id });
    release();
    await canceling;
    await flush();
    const after = sent.slice(before).map((m) => (m.formatFlag ? utf16(m) : `chunk@${parseChunk(m).offset}`));
    expect(after).toEqual(['chunk@1', `16|||${id}`]);

    const e2 = setup();
    const s2 = new MemorySink();
    await e2.engine.handle(hostOffer('9', 'a', 10));
    await e2.engine.accept('9', s2);
    await e2.engine.handle(hostCancel('9'));
    await flush();
    expect(s2.aborted).toBe(true);
    expect(e2.events.at(-1)).toEqual({ type: 'canceled', id: '9' });
    expect(e2.texts()).toEqual(['14|||9|||1']);
    await e2.engine.handle(hostCancel('9')); // second cancel: nothing
    expect(e2.events.filter((e) => e.type === 'canceled')).toHaveLength(1);
  });

  test('I/O failures: write, close, read and short reads cancel with the Swift string', async () => {
    expect(FILE_IO_REASON).toBe('The file could not be read or saved.');
    for (const mode of ['write', 'close'] as const) {
      const { engine, events, texts } = setup();
      const sink = new MemorySink();
      if (mode === 'write') sink.failWrite = true;
      else sink.failClose = true;
      await engine.handle(hostOffer('123', 'a', 3));
      await engine.accept('123', sink);
      await engine.handle(hostChunk('123', 1, u8(1, 2, 3)));
      await flush();
      expect(events.at(-1)).toEqual({ type: 'failed', id: '123', reason: FILE_IO_REASON });
      expect(texts().at(-1)).toBe('16|||123');
      expect(texts()).not.toContain('21|||123');
      expect(sink.aborted).toBe(true);
      expect(events.some((e) => e.type === 'completed')).toBe(false);
      expect(engine.count).toBe(0);
    }
    for (const mode of ['fail', 'short'] as const) {
      const { engine, events, texts } = setup();
      const source = new MemorySource(new Uint8Array(65_000));
      source[mode] = true;
      const id = engine.offer('a', source);
      await flush();
      await engine.handle(hostAccept(id));
      await flush();
      expect(events.at(-1)).toEqual({ type: 'failed', id, reason: FILE_IO_REASON });
      expect(texts().at(-1)).toBe(`16|||${id}`);
      expect(texts().filter((t) => t.startsWith('15'))).toEqual([]);
      expect(engine.count).toBe(0);
    }
    // A zero-byte file whose sink cannot be closed fails instead of completing.
    const { engine, events } = setup();
    const sink = new MemorySink();
    sink.failClose = true;
    await engine.handle(hostOffer('5', 'z', 0));
    await engine.accept('5', sink);
    expect(events.at(-1)).toEqual({ type: 'failed', id: '5', reason: FILE_IO_REASON });
    expect(sink.aborted).toBe(true);
  });

  test('the chunk is copied on entry (the decoder hands out a view into the multipart buffer)', async () => {
    const { engine } = setup();
    const sink = new MemorySink();
    let release = () => {};
    sink.gate = new Promise<void>((resolve) => (release = resolve));
    await engine.handle(hostOffer('123', 'a', 3));
    await engine.accept('123', sink);
    const buffer = u8(1, 2, 3);
    const pending = engine.handle(hostChunk('123', 1, buffer));
    buffer.fill(9); // the multipart buffer is reused after dispatch
    release();
    await pending;
    expect(sink.bytes).toEqual(u8(1, 2, 3));
  });

  test('a failing send of the offer removes the transfer; a failing accept send aborts and rethrows', async () => {
    const { engine, events, state } = setup();
    state.sendFails = true;
    const id = engine.offer('a', new MemorySource(new Uint8Array(3)));
    await flush();
    expect(events).toEqual([{ type: 'failed', id, reason: FILE_IO_REASON }]);
    expect(engine.count).toBe(0);
    state.sendFails = false;
    await engine.handle(hostOffer('1', 'a', 3));
    const sink = new MemorySink();
    state.sendFails = true;
    await expect(engine.accept('1', sink)).rejects.toThrow('not connected');
    expect(sink.aborted).toBe(true);
    expect(engine.count).toBe(0);
  });

  test('file names and contents never appear in events other than the incoming offer', async () => {
    const { engine, events } = setup();
    await engine.handle(hostOffer('1', 'SECRETNAME.txt', 3));
    const sink = new MemorySink();
    await engine.accept('1', sink);
    await engine.handle(hostChunk('1', 1, enc('abc')));
    await flush();
    const rest = events.filter((e) => e.type !== 'incoming');
    expect(JSON.stringify(rest)).not.toContain('SECRETNAME');
  });
});
