// Types for the Emscripten output src/codec/g722.js (see scripts/build-wasm.sh).
// Pointers and size_t are wasm32 numbers; size_t results may come back negative
// (signed i32) and must be normalized with `>>> 0`.

export interface G722Module {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _MacViewerG722Create(): number;
  _MacViewerG722Destroy(decoder: number): void;
  _MacViewerG722Decode(decoder: number, encoded: number, encodedLength: number, pcm: number, pcmCapacity: number): number;
}

declare function createG722Module(options?: { wasmBinary?: Uint8Array | ArrayBuffer }): Promise<G722Module>;
export default createG722Module;
