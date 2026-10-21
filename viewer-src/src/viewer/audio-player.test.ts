import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AudioPlayer } from './audio-player';
import { WORKLET_PROCESSOR_NAME } from './audio-queue';

class FakeParam {
  value = 1;
}
class FakeGain {
  gain = new FakeParam();
  connected: unknown[] = [];
  disconnected = false;
  connect(n: unknown): void {
    this.connected.push(n);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}
class FakePort {
  messages: { type: string; pcm?: Int16Array }[] = [];
  onmessage: unknown = undefined;
  postMessage(m: { type: string; pcm?: Int16Array }): void {
    this.messages.push(m);
  }
}
class FakeNode {
  static last: FakeNode | undefined;
  port = new FakePort();
  connected: unknown[] = [];
  disconnected = false;
  constructor(
    readonly context: FakeContext,
    readonly name: string,
    readonly options: { outputChannelCount: number[]; processorOptions: { capFrames: number; inputRate: number } },
  ) {
    FakeNode.last = this;
  }
  connect(n: unknown): void {
    this.connected.push(n);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}
class FakeContext {
  static instances: FakeContext[] = [];
  static rejectSampleRate = false;
  static moduleDelay: Promise<void> | undefined;
  state = 'suspended';
  destination = {};
  modules: string[] = [];
  gains: FakeGain[] = [];
  closed = false;
  audioWorklet = {
    addModule: async (url: string): Promise<void> => {
      await FakeContext.moduleDelay;
      this.modules.push(url);
    },
  };
  constructor(readonly options: { sampleRate?: number } = {}) {
    if (FakeContext.rejectSampleRate && options.sampleRate !== undefined) throw new DOMException('rate', 'NotSupportedError');
    FakeContext.instances.push(this);
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
  }
}

beforeEach(() => {
  FakeContext.instances = [];
  FakeContext.rejectSampleRate = false;
  FakeContext.moduleDelay = undefined;
  FakeNode.last = undefined;
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeNode);
});
afterEach(() => vi.unstubAllGlobals());

describe('AudioPlayer', () => {
  test('start creates a 48 kHz context, loads the worklet module and wires node -> gain -> output', async () => {
    const player = new AudioPlayer();
    await player.start();
    const ctx = FakeContext.instances[0]!;
    expect(ctx.options.sampleRate).toBe(48_000);
    expect(ctx.modules).toHaveLength(1);
    expect(ctx.state).toBe('running'); // resume() requested
    const node = FakeNode.last!;
    expect(node.name).toBe(WORKLET_PROCESSOR_NAME);
    expect(node.options.outputChannelCount).toEqual([2]);
    expect(node.options.processorOptions).toEqual({ capFrames: 12_000, inputRate: 48_000 });
    expect(node.connected).toEqual([ctx.gains[0]]);
    expect(ctx.gains[0]!.connected).toEqual([ctx.destination]);
    expect(player.running).toBe(true);
  });

  test('start is idempotent, also when called concurrently', async () => {
    const player = new AudioPlayer({ capFrames: 5 });
    await Promise.all([player.start(), player.start()]);
    await player.start();
    expect(FakeContext.instances).toHaveLength(1);
    expect(FakeNode.last!.options.processorOptions.capFrames).toBe(5);
  });

  test('falls back to the default sample rate when 48 kHz is refused (the worklet resamples)', async () => {
    FakeContext.rejectSampleRate = true;
    await new AudioPlayer().start();
    expect(FakeContext.instances[0]!.options.sampleRate).toBeUndefined();
    expect(FakeNode.last!.options.processorOptions.inputRate).toBe(48_000);
  });

  test('push forwards PCM, silence forwards bytes/4 zero frames; both ignored before start', async () => {
    const player = new AudioPlayer();
    player.push(Int16Array.of(1, 2));
    player.silence(8);
    expect(FakeNode.last).toBeUndefined();
    await player.start();
    const port = FakeNode.last!.port;
    player.push(Int16Array.of(1, 2, 3, 4));
    player.silence(19_200);
    player.silence(3);
    player.silence(-4);
    expect(port.messages).toHaveLength(2);
    expect(port.messages[0]!.pcm).toEqual(Int16Array.of(1, 2, 3, 4));
    expect(port.messages[1]!.pcm).toEqual(new Int16Array(9600));
  });

  test('a huge silence request is clamped to the queue cap before allocating', async () => {
    const player = new AudioPlayer();
    await player.start();
    player.silence(262_144);
    expect(FakeNode.last!.port.messages[0]!.pcm!.length).toBe(24_000);
  });

  test('setVolume drives the gain node, before and after start', async () => {
    const player = new AudioPlayer();
    player.setVolume(0.25);
    await player.start();
    const gain = FakeContext.instances[0]!.gains[0]!;
    expect(gain.gain.value).toBe(0.25);
    player.setVolume(0.75);
    expect(gain.gain.value).toBe(0.75);
  });

  test('stop clears the queue, disconnects, closes the context and allows a restart', async () => {
    const player = new AudioPlayer();
    await player.start();
    const ctx = FakeContext.instances[0]!;
    const node = FakeNode.last!;
    player.stop();
    expect(node.port.messages.at(-1)).toEqual({ type: 'clear' });
    expect(node.disconnected).toBe(true);
    expect(ctx.gains[0]!.disconnected).toBe(true);
    expect(ctx.closed).toBe(true);
    expect(player.running).toBe(false);
    player.push(Int16Array.of(1, 2));
    expect(node.port.messages.filter((m) => m.type === 'pcm')).toHaveLength(0);
    await player.start();
    expect(FakeContext.instances).toHaveLength(2);
    expect(player.running).toBe(true);
  });

  test('stop during start cancels it cleanly', async () => {
    let release!: () => void;
    FakeContext.moduleDelay = new Promise((r) => (release = r));
    const player = new AudioPlayer();
    const started = player.start();
    player.stop();
    release();
    await started;
    expect(player.running).toBe(false);
    expect(FakeContext.instances[0]!.closed).toBe(true);
  });

  test('a worklet load failure rejects start and releases the context', async () => {
    FakeContext.moduleDelay = Promise.reject(new Error('boom'));
    FakeContext.moduleDelay.catch(() => undefined);
    const player = new AudioPlayer();
    await expect(player.start()).rejects.toThrow('boom');
    expect(FakeContext.instances[0]!.closed).toBe(true);
    expect(player.running).toBe(false);
  });
});

describe('AudioPlayer restart races', () => {
  test('start right after a stop that cancelled a pending start really starts', async () => {
    let release!: () => void;
    FakeContext.moduleDelay = new Promise((r) => (release = r));
    const player = new AudioPlayer();
    const first = player.start();
    player.stop();
    FakeContext.moduleDelay = undefined;
    const second = player.start();
    release();
    await Promise.all([first, second]);
    expect(player.running).toBe(true);
    expect(FakeContext.instances).toHaveLength(2);
    expect(FakeContext.instances[0]!.closed).toBe(true);
    expect(FakeContext.instances[1]!.closed).toBe(false);
  });
});
