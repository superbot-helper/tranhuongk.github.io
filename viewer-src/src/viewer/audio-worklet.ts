// AudioWorklet processor for remote computer audio. Runs on the audio rendering
// thread; Vite bundles it as its own module (audio-player.ts imports it with
// `?worker&url`). The main thread posts interleaved Int16 stereo packets; the
// queue rules (250 ms cap, drop-all on overflow) live in audio-queue.ts.
//
// Nothing may import this file as a value: it calls registerProcessor, which exists
// only in the AudioWorklet scope. Shared names and types live in audio-queue.ts.
import {
  AUDIO_SOURCE_RATE,
  MAX_AUDIO_QUEUE_FRAMES,
  WORKLET_PROCESSOR_NAME,
  emptyQueue,
  enqueue,
  render,
} from './audio-queue';
import type { QueueState, WorkletMessage } from './audio-queue';

// The AudioWorklet global scope is not in the DOM lib typings.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
}
declare function registerProcessor(name: string, ctor: new (options?: { processorOptions?: unknown }) => AudioWorkletProcessor): void;

class PcmPlayerProcessor extends AudioWorkletProcessor {
  private queue: QueueState = emptyQueue();
  private readonly capFrames: number;
  /** Source frames consumed per output frame; 1 when the context runs at 48 kHz, else linear resampling. */
  private readonly step: number;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const o = (options?.processorOptions ?? {}) as { capFrames?: number; inputRate?: number };
    this.capFrames = o.capFrames ?? MAX_AUDIO_QUEUE_FRAMES;
    this.step = (o.inputRate ?? AUDIO_SOURCE_RATE) / sampleRate;
    this.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      const message = event.data;
      if (message.type === 'pcm') this.queue = enqueue(this.queue, message.pcm, this.capFrames);
      else if (message.type === 'clear') this.queue = emptyQueue();
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const left = channels?.[0];
    if (!left) return true;
    const right = channels?.[1] ?? left;
    this.queue = render(this.queue, left, right, this.step);
    return true;
  }
}

registerProcessor(WORKLET_PROCESSOR_NAME, PcmPlayerProcessor);
