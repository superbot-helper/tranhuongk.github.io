/// <reference types="vite/client" />
// Browser player for remote computer audio (MacViewer's RemoteAudioPlayer).
//
// Source format: 48 kHz signed 16-bit interleaved stereo. An AudioContext is
// created at 48 kHz when the browser supports the option; otherwise it runs at
// the device rate and the worklet resamples linearly (audio-queue.ts `render`).
// Packets go to an AudioWorklet over a message port; it keeps at most 250 ms
// queued (when a packet would overflow the cap the backlog is dropped, a single
// oversized packet keeps its newest 250 ms) so latency never builds up.
import { AUDIO_SOURCE_RATE, MAX_AUDIO_QUEUE_FRAMES, WORKLET_PROCESSOR_NAME, silenceFrames } from './audio-queue';
import type { WorkletMessage } from './audio-queue';
import workletUrl from './audio-worklet.ts?worker&url';

export { MAX_AUDIO_QUEUE_FRAMES, emptyQueue, enqueue, render, silenceFrames } from './audio-queue';
export type { QueueState } from './audio-queue';

export type AudioVolume = 0.25 | 0.5 | 0.75 | 1;
export const AUDIO_VOLUMES: readonly AudioVolume[] = [0.25, 0.5, 0.75, 1];

export interface AudioPlayerOptions {
  /** Queue cap in frames; default 12 000 (250 ms at 48 kHz). */
  capFrames?: number;
}

export type AudioPlayerErrorCode = 'suspended';

/** `suspended`: the browser kept the AudioContext suspended (no usable user gesture); ask the user to press again. */
export class AudioPlayerError extends Error {
  readonly code: AudioPlayerErrorCode;
  constructor(code: AudioPlayerErrorCode) {
    super(code);
    this.name = 'AudioPlayerError';
    this.code = code;
  }
}

/** How long start() waits for a second resume() before reporting `suspended`. */
const RESUME_TIMEOUT_MS = 1000;

export class AudioPlayer {
  private readonly capFrames: number;
  private volume: AudioVolume = 1;
  private context: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private gain: GainNode | undefined;
  private starting: Promise<void> | undefined;
  /** Bumped by stop() so a start() still awaiting the worklet module can tell it was cancelled. */
  private generation = 0;

  constructor(options: AudioPlayerOptions = {}) {
    this.capFrames = options.capFrames ?? MAX_AUDIO_QUEUE_FRAMES;
  }

  get running(): boolean {
    return this.node !== undefined;
  }

  /**
   * Create the AudioContext and load the worklet. Call it from a user gesture
   * (autoplay policy). Idempotent while running; concurrent calls share one start.
   */
  start(): Promise<void> {
    if (this.node) return Promise.resolve();
    if (this.starting) return this.starting;
    const starting: Promise<void> = this.doStart().finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    return starting;
  }

  /** Queue interleaved L,R Int16 samples. Ignored while stopped. */
  push(pcm: Int16Array): void {
    this.post({ type: 'pcm', pcm });
  }

  /** Queue `bytes` of PCM silence (4 bytes per stereo frame), as for command 42. */
  silence(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 4) return;
    this.post({ type: 'pcm', pcm: silenceFrames(Math.min(bytes, this.capFrames * 4)) });
  }

  setVolume(volume: AudioVolume): void {
    this.volume = volume;
    if (this.gain) this.gain.gain.value = volume;
  }

  /** Release the queued audio and the AudioContext. start() may be called again. */
  stop(): void {
    this.generation++;
    this.starting = undefined;
    const { node, gain, context } = this;
    this.node = this.gain = this.context = undefined;
    if (node) {
      node.port.postMessage({ type: 'clear' } satisfies WorkletMessage);
      node.port.onmessage = null;
      node.disconnect();
    }
    gain?.disconnect();
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }

  private post(message: WorkletMessage): void {
    this.node?.port.postMessage(message);
  }

  private async doStart(): Promise<void> {
    const generation = this.generation;
    const context = createContext();
    // Safari only honours resume() inside the user gesture: request it before any await.
    if (context.state !== 'running') void context.resume().catch(() => undefined);
    try {
      await context.audioWorklet.addModule(workletUrl);
      if (generation !== this.generation) throw new Error('stopped');
      const node = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { capFrames: this.capFrames, inputRate: AUDIO_SOURCE_RATE },
      });
      const gain = context.createGain();
      gain.gain.value = this.volume;
      node.connect(gain);
      gain.connect(context.destination);
      if (context.state !== 'running') await resumeWithin(context, RESUME_TIMEOUT_MS);
      if (generation !== this.generation) throw new Error('stopped');
      if (context.state !== 'running') throw new AudioPlayerError('suspended');
      this.context = context;
      this.node = node;
      this.gain = gain;
    } catch (e) {
      if (context.state !== 'closed') void context.close().catch(() => undefined);
      if (generation !== this.generation) return; // stop() raced the start: not an error
      throw e;
    }
  }
}

/** 48 kHz when the browser accepts the option (all current ones do); else the device rate. */
function createContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: AUDIO_SOURCE_RATE, latencyHint: 'interactive' });
  } catch {
    return new AudioContext({ latencyHint: 'interactive' });
  }
}

/** resume() can stay pending forever without a gesture, so it must not be awaited unbounded. */
async function resumeWithin(context: AudioContext, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([context.resume().catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
