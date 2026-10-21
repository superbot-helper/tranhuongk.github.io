// Playback queue rules of MacViewer's RemoteAudioPlayer (RemoteAudioPlayer.swift),
// as pure functions shared by the main thread (tests) and the AudioWorklet.
//
// Source audio is always 48 kHz signed 16-bit interleaved stereo (L, R, L, R...).
// The queue holds at most 250 ms (12 000 frames): when a new packet would push
// it over the cap the whole backlog is dropped (stale audio is worth less than
// a live view); a single packet bigger than the cap keeps only its newest frames.

/** 250 ms at the 48 kHz source rate (RemoteAudioPlayer.maximumQueuedFrames). */
export const MAX_AUDIO_QUEUE_FRAMES = 12_000;
/** Native sample rate of the remote audio. */
export const AUDIO_SOURCE_RATE = 48_000;

/** Name the processor registers under in the worklet scope. */
export const WORKLET_PROCESSOR_NAME = 'uv-pcm-player';

/** Messages AudioPlayer posts to the worklet. */
export type WorkletMessage = { type: 'pcm'; pcm: Int16Array } | { type: 'clear' };

export interface QueueState {
  /** Unplayed interleaved stereo Int16 chunks, oldest first. Never mutated. */
  readonly chunks: readonly Int16Array[];
  /** Frames already consumed from chunks[0]. */
  readonly offset: number;
  /** Unplayed frames in total (counts frames still in the chunks). */
  readonly frames: number;
  /** Resampler position (0 <= phase < 1) between the head frame and the next one. */
  readonly phase: number;
}

export function emptyQueue(): QueueState {
  return { chunks: [], offset: 0, frames: 0, phase: 0 };
}

/** `bytes` of PCM silence (command 42) as zero frames: 4 PCM bytes per stereo frame. */
export function silenceFrames(bytes: number): Int16Array {
  return new Int16Array(Math.floor(bytes / 4) * 2);
}

/**
 * Queue `pcm` (interleaved L,R Int16). Returns the new state; `state` is untouched.
 * 1. keep at most the newest `capFrames` frames of the packet;
 * 2. if queued + packet would exceed the cap, drop everything queued first.
 */
export function enqueue(state: QueueState, pcm: Int16Array, capFrames = MAX_AUDIO_QUEUE_FRAMES): QueueState {
  const sourceFrames = Math.floor(pcm.length / 2);
  const frames = Math.min(sourceFrames, capFrames);
  if (frames === 0) return state;
  const kept = frames === sourceFrames && pcm.length === frames * 2 ? pcm : pcm.subarray((sourceFrames - frames) * 2, sourceFrames * 2);
  if (state.frames + frames > capFrames) return { chunks: [kept], offset: 0, frames, phase: 0 };
  return { chunks: [...state.chunks, kept], offset: state.offset, frames: state.frames + frames, phase: state.phase };
}

/**
 * Fill `left`/`right` with Float32 samples (Int16 / 32768) consumed from the
 * queue. `step` is source frames per output frame (48 000 / context rate): 1 plays
 * 1:1, anything else resamples linearly. Not enough data (underrun) yields
 * silence for the remainder and leaves the queue as it is. Returns the new state.
 */
export function render(state: QueueState, left: Float32Array, right: Float32Array, step = 1): QueueState {
  let chunkIndex = 0;
  let offset = state.offset;
  let remaining = state.frames;
  let phase = state.phase;
  const count = Math.min(left.length, right.length);
  const chunks = state.chunks;
  let out = 0;
  for (; out < count; out++) {
    const head = chunks[chunkIndex];
    // Interpolating needs the frame after the head as well.
    if (head === undefined || remaining < (phase > 0 ? 2 : 1)) break;
    const at = offset * 2;
    const l0 = head[at]!;
    const r0 = head[at + 1]!;
    if (phase > 0) {
      const next = offset + 1 < head.length / 2 ? head : chunks[chunkIndex + 1]!;
      const nextAt = offset + 1 < head.length / 2 ? at + 2 : 0;
      left[out] = (l0 + (next[nextAt]! - l0) * phase) / 32768;
      right[out] = (r0 + (next[nextAt + 1]! - r0) * phase) / 32768;
    } else {
      left[out] = l0 / 32768;
      right[out] = r0 / 32768;
    }
    phase += step;
    let advance = Math.floor(phase);
    phase -= advance;
    advance = Math.min(advance, remaining);
    remaining -= advance;
    offset += advance;
    let size = head.length / 2;
    while (chunkIndex < chunks.length && offset >= size) {
      offset -= size;
      chunkIndex++;
      size = (chunks[chunkIndex]?.length ?? 0) / 2;
    }
  }
  left.fill(0, out, count);
  right.fill(0, out, count);
  return { chunks: chunks.slice(chunkIndex), offset, frames: remaining, phase };
}
