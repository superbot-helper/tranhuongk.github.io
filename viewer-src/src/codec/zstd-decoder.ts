// Port of UltraViewerProtocol/ZstdScreenDecoder.swift on top of Zstandard 1.5.7
// compiled to WebAssembly (zstd.js/zstd.wasm, built by scripts/build-wasm.sh).
//
// Streaming reader for the frame family observed in uvc.dll ordinal 16. Call
// reset() before each independent drawing mission (ordinal 25 does this in the
// inspected client); keep the same object across fragments within a frame.
import { loadBinaryAsset } from './asset';
import createZstdModule from './zstd.js';
import type { ZstdModule } from './zstd.js';

const WASM_URL = new URL('./zstd.wasm', import.meta.url);

/** zstd.h: ZSTD_d_windowLogMax. */
const ZSTD_D_WINDOW_LOG_MAX = 100;
/** zstd.h: ZSTD_reset_session_only. */
const ZSTD_RESET_SESSION_ONLY = 1;
/** The inspected UVC header rejects a window above 0x8000000 bytes. */
const WINDOW_LOG_MAX = 27;
/** Per-call output staging, as in Swift: min(128 KiB, maximumOutputBytes). */
const OUTPUT_CHUNK = 128 * 1024;
/** sizeof(ZSTD_inBuffer) == sizeof(ZSTD_outBuffer) on wasm32: three 32-bit words. */
const BUFFER_STRUCT = 12;

export type ZstdScreenDecoderErrorCode =
  | 'allocationFailed'
  | 'invalidData'
  | 'outputLimitExceeded'
  | 'incompleteFrame'
  | 'resetRequired';

export class ZstdScreenDecoderError extends Error {
  readonly code: ZstdScreenDecoderErrorCode;
  /** For invalidData: ZSTD_getErrorName() text, e.g. "Dictionary mismatch". */
  readonly detail: string | undefined;
  constructor(code: ZstdScreenDecoderErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'ZstdScreenDecoderError';
    this.code = code;
    this.detail = detail;
  }
}

let modulePromise: Promise<ZstdModule> | undefined;

/** One shared wasm instance; each decoder owns its own DStream inside it. */
function zstdModule(): Promise<ZstdModule> {
  modulePromise ??= loadBinaryAsset(WASM_URL)
    .then((wasmBinary) => createZstdModule({ wasmBinary }))
    .catch((e: unknown) => {
      modulePromise = undefined;
      throw e;
    });
  return modulePromise;
}

interface Allocation {
  mod: ZstdModule;
  dctx: number;
  /** ZSTD_inBuffer at +0, ZSTD_outBuffer at +12. */
  io: number;
  output: number;
  input: number;
}

function release(a: Allocation): void {
  if (a.dctx) a.mod._ZSTD_freeDStream(a.dctx);
  if (a.io) a.mod._free(a.io);
  if (a.output) a.mod._free(a.output);
  if (a.input) a.mod._free(a.input);
  a.dctx = a.io = a.output = a.input = 0;
}

const finalizer = new FinalizationRegistry<Allocation>(release);

function readCString(mod: ZstdModule, ptr: number): string {
  const heap = mod.HEAPU8;
  let end = ptr;
  while (end < heap.length && heap[end] !== 0) end++;
  return new TextDecoder().decode(heap.subarray(ptr, end));
}

/** Use from one serial caller; the decoder is stateful across append() calls. */
export class ZstdScreenDecoder {
  readonly maximumOutputBytes: number;
  private readonly alloc: Allocation;
  private inputCapacity = 0;
  private readonly outputCapacity: number;
  private frameOutputCount = 0;
  private lastHint = 0;
  private started = false;
  private failed = false;
  private disposed = false;

  private constructor(alloc: Allocation, maximumOutputBytes: number, outputCapacity: number) {
    this.alloc = alloc;
    this.maximumOutputBytes = maximumOutputBytes;
    this.outputCapacity = outputCapacity;
    finalizer.register(this, alloc, this);
  }

  static async create(
    dictionary?: Uint8Array | null,
    maximumOutputBytes = 128 * 1024 * 1024,
  ): Promise<ZstdScreenDecoder> {
    if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0) {
      throw new RangeError('maximumOutputBytes must be a positive integer');
    }
    const mod = await zstdModule();
    const alloc: Allocation = { mod, dctx: 0, io: 0, output: 0, input: 0 };
    const outputCapacity = Math.min(OUTPUT_CHUNK, maximumOutputBytes);
    try {
      alloc.dctx = mod._ZSTD_createDStream();
      if (!alloc.dctx) throw new ZstdScreenDecoderError('allocationFailed');
      check(mod, mod._ZSTD_initDStream(alloc.dctx));
      if (dictionary) {
        // ZSTD_DCtx_loadDictionary copies the bytes, so the staging copy is freed at once.
        const ptr = dictionary.length ? mod._malloc(dictionary.length) : 0;
        if (dictionary.length && !ptr) throw new ZstdScreenDecoderError('allocationFailed');
        try {
          mod.HEAPU8.set(dictionary, ptr);
          check(mod, mod._ZSTD_DCtx_loadDictionary(alloc.dctx, ptr, dictionary.length));
        } finally {
          if (ptr) mod._free(ptr);
        }
      }
      check(mod, mod._ZSTD_DCtx_setParameter(alloc.dctx, ZSTD_D_WINDOW_LOG_MAX, WINDOW_LOG_MAX));
      alloc.io = mod._malloc(BUFFER_STRUCT * 2);
      alloc.output = mod._malloc(outputCapacity);
      if (!alloc.io || !alloc.output) throw new ZstdScreenDecoderError('allocationFailed');
    } catch (e) {
      release(alloc);
      throw e;
    }
    return new ZstdScreenDecoder(alloc, maximumOutputBytes, outputCapacity);
  }

  get hasIncompleteFrame(): boolean {
    return this.started && this.lastHint !== 0;
  }

  reset(): void {
    this.assertLive();
    // UVC ordinal25 preserves the DDict installed by ordinal22. initDStream would
    // clear dictionaries, so reset only the session here.
    check(this.alloc.mod, this.alloc.mod._ZSTD_DCtx_reset(this.alloc.dctx, ZSTD_RESET_SESSION_ONLY));
    this.frameOutputCount = 0;
    this.lastHint = 0;
    this.started = false;
    this.failed = false;
  }

  /**
   * Bounded streaming output. Both one frame's expansion and one append's
   * returned output are limited. A failed decoder requires explicit reset().
   */
  append(compressed: Uint8Array): Uint8Array {
    this.assertLive();
    if (this.failed) throw new ZstdScreenDecoderError('resetRequired');
    if (compressed.length === 0) return new Uint8Array();
    try {
      return this.decompress(compressed);
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }

  /** Call at the end of an independently framed compressed mission. */
  finish(): void {
    this.assertLive();
    if (this.failed) throw new ZstdScreenDecoderError('resetRequired');
    if (this.hasIncompleteFrame) throw new ZstdScreenDecoderError('incompleteFrame');
  }

  /** Frees the wasm-side stream and buffers. Idempotent; later use throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    finalizer.unregister(this);
    release(this.alloc);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('ZstdScreenDecoder disposed');
  }

  private decompress(compressed: Uint8Array): Uint8Array {
    const { mod, dctx, io, output } = this.alloc;
    const input = this.stageInput(compressed);
    const inStruct = io;
    const outStruct = io + BUFFER_STRUCT;
    let view = new DataView(mod.HEAPU8.buffer);
    view.setUint32(inStruct, input, true);
    view.setUint32(inStruct + 4, compressed.length, true);
    view.setUint32(inStruct + 8, 0, true);

    const chunks: Uint8Array[] = [];
    let total = 0;
    let needsDrain: boolean;
    let inputPosition = 0;
    do {
      const priorPosition = inputPosition;
      view.setUint32(outStruct, output, true);
      view.setUint32(outStruct + 4, this.outputCapacity, true);
      view.setUint32(outStruct + 8, 0, true);
      const code = mod._ZSTD_decompressStream(dctx, outStruct, inStruct);
      check(mod, code);
      const hint = code >>> 0;
      // Memory may have grown during the call; take a fresh view of the heap.
      view = new DataView(mod.HEAPU8.buffer);
      const produced = view.getUint32(outStruct + 8, true);
      inputPosition = view.getUint32(inStruct + 8, true);
      this.started = true;
      this.lastHint = hint;
      if (produced > this.maximumOutputBytes - this.frameOutputCount || produced > this.maximumOutputBytes - total) {
        throw new ZstdScreenDecoderError('outputLimitExceeded');
      }
      if (produced > 0) chunks.push(mod.HEAPU8.slice(output, output + produced));
      total += produced;
      this.frameOutputCount += produced;
      if (hint === 0) this.frameOutputCount = 0;
      needsDrain = produced === this.outputCapacity && hint !== 0;
      if (priorPosition === inputPosition && produced === 0) break;
    } while (inputPosition < compressed.length || needsDrain);
    return chunks.length === 1 ? (chunks[0] as Uint8Array) : joinChunks(chunks, total);
  }

  private stageInput(compressed: Uint8Array): number {
    const { mod } = this.alloc;
    if (this.inputCapacity < compressed.length) {
      if (this.alloc.input) mod._free(this.alloc.input);
      this.alloc.input = 0;
      this.inputCapacity = 0;
      const ptr = mod._malloc(compressed.length);
      if (!ptr) throw new ZstdScreenDecoderError('allocationFailed');
      this.alloc.input = ptr;
      this.inputCapacity = compressed.length;
    }
    mod.HEAPU8.set(compressed, this.alloc.input);
    return this.alloc.input;
  }
}

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function check(mod: ZstdModule, code: number): void {
  if (mod._ZSTD_isError(code) !== 0) {
    throw new ZstdScreenDecoderError('invalidData', readCString(mod, mod._ZSTD_getErrorName(code)));
  }
}
