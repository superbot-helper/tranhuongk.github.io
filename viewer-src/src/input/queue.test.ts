import { describe, expect, test, vi } from 'vitest';
import { InputQueue } from './queue';

type Msg = string | Uint8Array;
const move = (x: number): string => `8|||512|||0|||${x}|||0`;
const key = (n: number): Uint8Array => new Uint8Array([30, 124, 124, 124, 1, n, 0, 0, 0, 0, 0]);
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

  test('overflowNotifiesOwnerOnceAndPreservesAcceptedEvents', async () => {
    const sent: Msg[] = [];
    const onOverflow = vi.fn();
    const q = new InputQueue(async (m) => void sent.push(m), onOverflow, 2);
    q.push('8|||513|||1|||2');
    q.push(move(1));
    // Replacing an adjacent move needs no new capacity, even at the limit.
    q.push(move(99));
    expect(onOverflow).not.toHaveBeenCalled();
    q.push(key(1));
    expect(onOverflow).toHaveBeenCalledTimes(1);
    q.push(key(2));
    q.push(move(5));
    expect(onOverflow).toHaveBeenCalledTimes(1);
    await flush();
    expect(sent).toEqual(['8|||513|||1|||2', move(99)]);
    expect(q.length).toBe(0);
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
    expect(q.length).toBe(8192);
    q.clear();
    expect(q.length).toBe(0);
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
