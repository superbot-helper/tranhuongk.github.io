// Types for the Emscripten output src/codec/zstd.js (see scripts/build-wasm.sh).
// Pointers and size_t are wasm32 numbers; size_t results may come back negative
// (signed i32) and must be normalized with `>>> 0`.

export interface ZstdModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _ZSTD_createDStream(): number;
  _ZSTD_freeDStream(dctx: number): number;
  _ZSTD_initDStream(dctx: number): number;
  _ZSTD_DCtx_loadDictionary(dctx: number, dict: number, dictSize: number): number;
  _ZSTD_DCtx_setParameter(dctx: number, param: number, value: number): number;
  _ZSTD_DCtx_reset(dctx: number, directive: number): number;
  _ZSTD_decompressStream(dctx: number, output: number, input: number): number;
  _ZSTD_isError(code: number): number;
  _ZSTD_getErrorName(code: number): number;
}

declare function createZstdModule(options?: { wasmBinary?: Uint8Array | ArrayBuffer }): Promise<ZstdModule>;
export default createZstdModule;
