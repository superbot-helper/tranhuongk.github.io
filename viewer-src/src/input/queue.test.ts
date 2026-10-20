import { describe, expect, test, vi } from 'vitest';
import { InputQueue } from './queue';

type Msg = string | Uint8Array;
const move = (x: number): string => `8|||512|||0|||${x}|||0`;
const key = (n: number): Uint8Array => new Uint8Array([30, 124, 124, 124, 1, n, 0, 0, 0, 0, 0]);
const keyUp = (n: number, kind = 2): Uint8Array => new Uint8Array([30, 124, 124, 124, kind, n, 0, 0, 0, 0, 0]);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A sender whose promises the test resolves one by one. */
function gatedSender() {
  const sent: Msg[] = [];
  const gates: (() => void)[] = [];
  const send = (m: Msg): Promise<void> => {
    sent.push(m);
    return new Promise<void>((resolve) => gates.push(resolve));
  };
  const release = async (): Promise<void> => {
    gates.shift()?.();
    await flush();
  };
  return { sent, send, release, gates };
}

describe('InputQueue (RemoteInputBufferTests.swift)', () => {
  test('moveBurstsKeepLastPositionBeforeEveryCriticalBoundary', async () => {
    const sent: Msg[] = [];
    const q = new InputQueue(async (m) => void sent.push(m), vi.fn());
    for (let x = 0; x < 125; x++) q.push(move(x));
    q.push('8|||513|||1|||0'); // button down
    for (let x = 125; x < 250; x++) q.push(move(x));
    const k = key(0x41);
    q.push(k);
    q.push(key(0x10));
    q.push(move(250));
    q.push('8|||514|||0|||0');
    await flush();
    expect(sent).toEqual([move(124), '8|||513|||1|||0', move(249), k, key(0x10), move(250), '8|||514|||0|||0']);
    expect(q.length).toBe(0);
  });

  test('three adjacent moves while a send is in flight: only the last is sent', async () => {
    const g = gatedSender();
    const q = new InputQueue(g.send, vi.fn());
    q.push(key(1));
    await flush();
    expect(g.sent).toEqual([key(1)]); // in flight, not yet acknowledged
    q.push(move(1));
    q.push(move(2));
    q.push(move(3));
    expect(q.length).toBe(1);
    await g.release();
    expect(g.sent).toEqual([key(1), move(3)]);
    await g.release();
    expect(g.sent).toHaveLength(2);
  });

  test('a move already handed to send is never replaced', async () => {
    const g = gatedSender();
    const q = new InputQueue(g.send, vi.fn());
    q.push(move(1));
    await flush();
    q.push(move(2));
    await g.release();
    expect(g.sent).toEqual([move(1), move(2)]);
  });

  test('sending is strictly sequential: the next message waits for the previous promise', async () => {
    const g = gatedSender();
    const q = new InputQueue(g.send, vi.fn());
    q.push(key(1));
    q.push(key(2));
    q.push(key(3));
    await flush();
    expect(g.sent).toEqual([key(1)]);
    await g.release();
    expect(g.sent).toEqual([key(1), key(2)]);
    await g.release();
    await g.release();
    expect(g.sent).toEqual([key(1), key(2), key(3)]);
  });

  test('releaseButtonsScrollAndRepeatedKeysAreNeverCoalesced', async () => {
    const sent: Msg[] = [];
    const q = new InputQueue(async (m) => void sent.push(m), vi.fn());
    const events: Msg[] = ['8|||513|||1|||2', '8|||522|||1|||2', '8|||522|||1|||2', key(1), key(1), key(2), '8|||514|||1|||2', key(9), key(9)];
    for (const e of events) q.push(e);
    await flush();
    expect(sent).toEqual(events);
  });

  test('moves separated by a key are not merged, and key-up never replaces a move', async () => {
    const sent: Msg[] = [];
    const q = new InputQueue(async (m) => void sent.push(m), vi.fn());
    q.push(move(1));
    q.push(key(1));
    q.push(move(2));
    await flush();
    expect(sent).toEqual([move(1), key(1), move(2)]);
  });

  test('overflow reports once and keeps only pending releases, in order', async () => {
    const sent: Msg[] = [];
    const onOverflow = vi.fn();
    const q = new InputQueue(async (m) => void sent.push(m), onOverflow, 4);
    q.push('8|||513|||1|||2'); // left down: dropped on overflow
    q.push(keyUp(1));
    q.push('8|||514|||0|||2'); // left up
    // Replacing an adjacent move needs no new capacity, even at the limit.
    q.push(move(1));
    q.push(move(99));
    expect(onOverflow).not.toHaveBeenCalled();
    expect(q.length).toBe(4);
    q.push(key(9)); // 5th pending message: overflow
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(q.length).toBe(2);
    q.push(key(2));
    q.push(move(5));
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(q.length).toBe(2);
    await flush();
    expect(sent).toEqual([keyUp(1), '8|||514|||0|||2']);
  });

  test('after overflow release pushes are still accepted (the owner enqueues releaseAll from onOverflow)', async () => {
    const sent: Msg[] = [];
    let q!: InputQueue;
    q = new InputQueue(
      async (m) => void sent.push(m),
      () => {
        q.push(keyUp(0x41));
        q.push('8|||517|||0|||0');
        q.push(keyUp(0x10, 4));
      },
      2,
    );
    q.push(key(1));
    q.push(key(2));
    q.push(key(3));
    await flush();
    expect(sent).toEqual([keyUp(0x41), '8|||517|||0|||0', keyUp(0x10, 4)]);
    // Still overflowed: ordinary input is dropped until clear().
    q.push(key(4));
    await flush();
    expect(sent).toHaveLength(3);
    q.clear();
    q.push(key(5));
    await flush();
    expect(sent.at(-1)).toEqual(key(5));
  });

  test('a release arriving exactly at capacity is kept, and a stray release does not count as overflow input', async () => {
    const sent: Msg[] = [];
    const onOverflow = vi.fn();
    const q = new InputQueue(async (m) => void sent.push(m), onOverflow, 2);
    q.push(key(1));
    q.push(key(2));
    q.push(keyUp(7));
    expect(onOverflow).toHaveBeenCalledTimes(1);
    await flush();
    expect(sent).toEqual([keyUp(7)]);
  });

  test('default capacity is 8192: the 8193rd pending message overflows once; clear() re-arms', async () => {
    const g = gatedSender();
    const onOverflow = vi.fn();
    const q = new InputQueue(g.send, onOverflow);
    for (let i = 0; i < 8192; i++) q.push(key(i & 0xff));
    expect(onOverflow).not.toHaveBeenCalled();
    q.push(key(1));
    expect(onOverflow).toHaveBeenCalledTimes(1);
    q.push(key(2));
    q.push(key(3));
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(q.length).toBe(0); // only key-downs were pending: all dropped
    q.clear();
    q.push(key(7));
    expect(q.length).toBe(1);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    await flush();
    expect(g.sent.at(-1)).toEqual(key(7));
  });

  test('capacity of at least 4096 critical events is accepted', async () => {
    const sent: Msg[] = [];
    const onOverflow = vi.fn();
    const q = new InputQueue(async (m) => void sent.push(m), onOverflow);
    for (let i = 0; i < 4096; i++) q.push(key(0x10));
    expect(q.length).toBe(4096);
    await flush();
    for (let i = 0; i < 200 && sent.length < 4096; i++) await flush();
    expect(sent).toHaveLength(4096);
    expect(onOverflow).not.toHaveBeenCalled();
  });

  test('clear drops pending messages (not the in-flight one) and later pushes still send', async () => {
    const g = gatedSender();
    const q = new InputQueue(g.send, vi.fn());
    q.push(key(1));
    await flush();
    q.push(key(2));
    q.push(key(3));
    q.clear();
    await g.release();
    expect(g.sent).toEqual([key(1)]);
    q.push(key(4));
    await flush();
    expect(g.sent).toEqual([key(1), key(4)]);
  });

  test('clear keeps a pending key up whose down is in flight', async () => {
    const g = gatedSender();
    const q = new InputQueue(g.send, vi.fn());
    q.push(key(0x41)); // down, in flight
    await flush();
    q.push(move(1));
    q.push(keyUp(0x41));
    q.push(key(0x42));
    q.clear();
    expect(q.length).toBe(1);
    await g.release();
    expect(g.sent).toEqual([key(0x41), keyUp(0x41)]);
  });

  test('clear keeps every release in order: key up kind 2 and 4, mouse up 514/517/520; drops downs, moves, wheel, other', async () => {
    const g = gatedSender();
    const q = new InputQueue(g.send, vi.fn());
    q.push(key(0)); // in flight
    await flush();
    const kept: Msg[] = [keyUp(1), '8|||514|||0|||5', keyUp(2, 4), '8|||517|||0|||5', '8|||520|||0|||5'];
    const dropped: Msg[] = [key(3), keyUp(4, 3), '8|||513|||1|||5', '8|||516|||2|||5', '8|||519|||16|||5', '8|||522|||7864320|||0', move(3), '8|||515|||0|||5', '23|||0'];
    for (let i = 0; i < kept.length; i++) {
      q.push(dropped[i]!);
      q.push(kept[i]!);
    }
    for (const d of dropped.slice(kept.length)) q.push(d);
    q.clear();
    for (let i = 0; i < kept.length + 1; i++) await g.release();
    expect(g.sent).toEqual([key(0), ...kept]);
  });

  test('a rejecting send is reported and does not stop the queue', async () => {
    const sent: Msg[] = [];
    const onError = vi.fn();
    const send = async (m: Msg): Promise<void> => {
      sent.push(m);
      if (sent.length === 1) throw new Error('closed');
    };
    const q = new InputQueue(send, vi.fn(), 8192, onError);
    q.push(key(1));
    q.push(key(2));
    await flush();
    expect(sent).toEqual([key(1), key(2)]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('a rejected send without an error handler does not leave an unhandled rejection', async () => {
    const q = new InputQueue(() => Promise.reject(new Error('closed')), vi.fn());
    q.push(key(1));
    await flush();
    expect(q.length).toBe(0);
  });
});

describe('InputQueue error handler', () => {
  test('a throwing onError neither stops the queue nor leaks an unhandled rejection', async () => {
    const sent: Msg[] = [];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const send = async (m: Msg): Promise<void> => {
      sent.push(m);
      throw new Error('closed');
    };
    const q = new InputQueue(send, vi.fn(), 8192, () => {
      throw new Error('handler bug');
    });
    q.push(key(1));
    q.push(key(2));
    await flush();
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(sent).toEqual([key(1), key(2)]);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
