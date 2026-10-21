// Port of UltraViewerProtocol/G722Decoder.swift: the 64 kbit/s G.722 decoder of
// computer audio (command 43), compiled to WebAssembly (g722.js/g722.wasm, built
// by scripts/build-wasm.sh from MacViewer's ThirdParty/g722). The C boundary keeps
// NAudio's Int16 wrap of the final QMF output (the pinned WebRTC decoder saturates).
//
// One encoded byte becomes two Int16 samples. The caller treats the result as the
// native playback format, 48 kHz stereo interleaved, despite G.722's usual label.
// Keep one decoder per authenticated session: through pause, resume and silence;
// create a new one only when a new session starts.
import { MAX_ENCODED_PACKET_BYTES } from '../proto/audio-message';
import { loadBinaryAsset } from './asset';
import createG722Module from './g722.js';
import type { G722Module } from './g722.js';

const WASM_URL = new URL('./g722.wasm', import.meta.url);

let modulePromise: Promise<G722Module> | undefined;

/** One shared wasm instance; each decoder owns its own state inside it. */
function g722Module(): Promise<G722Module> {
  modulePromise ??= loadBinaryAsset(WASM_URL)
    .then((wasmBinary) => createG722Module({ wasmBinary }))
    .catch((e: unknown) => {
      modulePromise = undefined;
      throw e;
    });
  return modulePromise;
}

interface Allocation {
  mod: G722Module;
  state: number;
  input: number;
  output: number;
}

function release(a: Allocation): void {
  if (a.state) a.mod._MacViewerG722Destroy(a.state);
  if (a.input) a.mod._free(a.input);
  if (a.output) a.mod._free(a.output);
  a.state = a.input = a.output = 0;
}

const finalizer = new FinalizationRegistry<Allocation>(release);

/** Use from one serial caller; the decoder is stateful across decode() calls. */
export class G722Decoder {
  private readonly alloc: Allocation;
  /** Capacity of the staged buffers, in encoded bytes. */
  private capacity = 0;
  private disposed = false;

  private constructor(alloc: Allocation) {
    this.alloc = alloc;
    finalizer.register(this, alloc, this);
  }

  static async create(): Promise<G722Decoder> {
    const mod = await g722Module();
    const state = mod._MacViewerG722Create();
    if (!state) throw new Error('G722Decoder: allocationFailed');
    return new G722Decoder({ mod, state, input: 0, output: 0 });
  }

  /**
   * Decode a packet (at most MAX_ENCODED_PACKET_BYTES) into a fresh Int16Array of
   * 2 samples per byte. An empty packet returns an empty array and does not touch
   * the state; an oversized one throws RangeError before changing the state.
   */
  decode(encoded: Uint8Array): Int16Array {
    if (this.disposed) throw new Error('G722Decoder disposed');
    if (encoded.length > MAX_ENCODED_PACKET_BYTES) throw new RangeError('packetTooLarge');
    if (encoded.length === 0) return new Int16Array();
    const { mod, state } = this.alloc;
    this.ensureCapacity(encoded.length);
    mod.HEAPU8.set(encoded, this.alloc.input);
    const sampleCount = encoded.length * 2;
    const produced = mod._MacViewerG722Decode(state, this.alloc.input, encoded.length, this.alloc.output, sampleCount) >>> 0;
    if (produced !== sampleCount) throw new Error('G722Decoder: decoderFailure');
    // Copy out of the heap: memory may grow (detaching old views) and later calls reuse the buffer.
    const out = new Int16Array(sampleCount);
    new Uint8Array(out.buffer).set(mod.HEAPU8.subarray(this.alloc.output, this.alloc.output + sampleCount * 2));
    return out;
  }

  /** Frees the wasm-side state and buffers. Idempotent; later use throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    finalizer.unregister(this);
    release(this.alloc);
  }

  private ensureCapacity(encodedBytes: number): void {
    if (this.capacity >= encodedBytes) return;
    const { mod } = this.alloc;
    if (this.alloc.input) mod._free(this.alloc.input);
    if (this.alloc.output) mod._free(this.alloc.output);
    this.alloc.input = this.alloc.output = 0;
    this.capacity = 0;
    const input = mod._malloc(encodedBytes);
    const output = mod._malloc(encodedBytes * 4);
    if (!input || !output) {
      if (input) mod._free(input);
      if (output) mod._free(output);
      throw new Error('G722Decoder: allocationFailed');
    }
    this.alloc.input = input;
    this.alloc.output = output;
    this.capacity = encodedBytes;
  }
}
