#!/usr/bin/env bash
# Rebuilds the committed WebAssembly codecs with Emscripten:
#   src/codec/zstd.js + zstd.wasm   the decompression side of Zstandard 1.5.7
#                                   (plus legacy formats from v0.4, as MacViewer's
#                                   Package.swift builds it with ZSTD_LEGACY_SUPPORT=4)
#   src/codec/g722.js + g722.wasm   MacViewer's G.722 decoder (pinned WebRTC
#                                   g722_decode.c + MacViewerG722.c with the NAudio
#                                   Int16 output-wrap compatibility fix)
#
# The outputs are committed (GitHub Pages has no build step); rerun this script
# only when a source, the export list or the flags change.
#
# Usage: build-wasm.sh [zstd|g722|all]   (default: all)
#
# Environment:
#   EMSDK     emsdk checkout (default: $HOME/.local/share/emsdk). Install it
#             isolated, e.g.:
#               git clone https://github.com/emscripten-core/emsdk "$HOME/.local/share/emsdk"
#               cd "$HOME/.local/share/emsdk" && ./emsdk install latest && ./emsdk activate latest
#             (emsdk needs Python >= 3.10; set EMSDK_PYTHON if the default python3 is older.)
#   ZSTD_SRC  zstd source tree (the directory holding lib/). Default: $MV/ThirdParty/zstd
#             when MV (a MacViewer checkout) is set, otherwise the official
#             zstd-1.5.7.tar.gz release is downloaded and checked against its SHA-256.
#   G722_SRC  MacViewer's ThirdParty/g722 (holding g722_decode.c, MacViewerG722.c and
#             include/). Default: $MV/ThirdParty/g722. Required for the g722 target;
#             the two upstream files are checked against provenance.json's SHA-256.
set -euo pipefail

target="${1:-all}"
case "$target" in zstd | g722 | all) ;; *)
  echo "usage: $0 [zstd|g722|all]" >&2
  exit 2
  ;;
esac

here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/src/codec"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ZSTD_VERSION=1.5.7
ZSTD_TARBALL_URL="https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/zstd-${ZSTD_VERSION}.tar.gz"
ZSTD_TARBALL_SHA256=eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3
# ThirdParty/g722/provenance.json: WebRTC commit 4fdd50a57b79826ea87cc5170be78b6444d9cdf9.
G722_DECODE_SHA256=ad930feb5e109d06d9ba047f339926f295da41dae3c4f00cf136aa84fd50e24d
G722_HEADER_SHA256=33606ddc73e46803176e0e5936ced4e8600c2e6e3209776bc224a95a22d5539b

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

resolve_zstd_src() {
  if [ -z "${ZSTD_SRC:-}" ]; then
    if [ -n "${MV:-}" ]; then
      ZSTD_SRC="$MV/ThirdParty/zstd"
    else
      echo "Downloading $ZSTD_TARBALL_URL" >&2
      curl -fsSL -o "$work/zstd.tar.gz" "$ZSTD_TARBALL_URL"
      actual="$(sha256 "$work/zstd.tar.gz")"
      if [ "$actual" != "$ZSTD_TARBALL_SHA256" ]; then
        echo "zstd tarball SHA-256 mismatch: $actual" >&2
        exit 1
      fi
      tar -xzf "$work/zstd.tar.gz" -C "$work"
      ZSTD_SRC="$work/zstd-${ZSTD_VERSION}"
    fi
  fi
  ZSTD_SRC="$(cd "$ZSTD_SRC" && pwd)"

  version="$(awk '/#define ZSTD_VERSION_(MAJOR|MINOR|RELEASE)/ {printf "%s%s", sep, $3; sep="."}' "$ZSTD_SRC/lib/zstd.h")"
  if [ "$version" != "$ZSTD_VERSION" ]; then
    echo "expected zstd $ZSTD_VERSION in $ZSTD_SRC, found $version" >&2
    exit 1
  fi
}

EMSDK="${EMSDK:-$HOME/.local/share/emsdk}"
if [ -z "${EMSDK_PYTHON:-}" ]; then
  for candidate in python3 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      EMSDK_PYTHON="$(command -v "$candidate")"
      export EMSDK_PYTHON
      break
    fi
  done
fi
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
emcc_version="$(emcc --version | head -n 1)"

build_zstd() {
  resolve_zstd_src
  sources=(
    lib/common/debug.c lib/common/entropy_common.c lib/common/error_private.c
    lib/common/fse_decompress.c lib/common/xxhash.c lib/common/zstd_common.c
    lib/decompress/huf_decompress.c lib/decompress/zstd_ddict.c
    lib/decompress/zstd_decompress.c lib/decompress/zstd_decompress_block.c
    lib/legacy/zstd_v04.c lib/legacy/zstd_v05.c lib/legacy/zstd_v06.c lib/legacy/zstd_v07.c
  )
  exports=(
    _ZSTD_createDStream _ZSTD_initDStream _ZSTD_DCtx_loadDictionary _ZSTD_DCtx_setParameter
    _ZSTD_DCtx_reset _ZSTD_decompressStream _ZSTD_isError _ZSTD_getErrorName _ZSTD_freeDStream
    _malloc _free
  )

  (
    cd "$ZSTD_SRC"
    emcc -O3 \
      -DZSTD_LEGACY_SUPPORT=4 -DZSTD_DISABLE_ASM=1 -DZSTD_TRACE=0 -DNDEBUG \
      -I lib -I lib/common \
      -ffile-prefix-map="$ZSTD_SRC"=zstd \
      "${sources[@]}" \
      --no-entry \
      -sEXPORTED_FUNCTIONS="$(IFS=,; echo "${exports[*]}")" \
      -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
      -sINCOMING_MODULE_JS_API=wasmBinary \
      -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createZstdModule \
      -sENVIRONMENT=web,worker \
      -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=512MB \
      -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 -sSUPPORT_ERRNO=0 \
      -o "$work/zstd.js"
  )

  {
    echo "// GENERATED by viewer-src/scripts/build-wasm.sh. Do not edit."
    echo "// Zstandard $ZSTD_VERSION decompression (ZSTD_LEGACY_SUPPORT=4), BSD license: see THIRD_PARTY_NOTICES.md."
    echo "// Compiler: $emcc_version"
    cat "$work/zstd.js"
  } >"$out/zstd.js"
  cp "$work/zstd.wasm" "$out/zstd.wasm"
  echo "zstd.js   $(wc -c <"$out/zstd.js" | tr -d ' ') bytes  sha256 $(sha256 "$out/zstd.js")"
  echo "zstd.wasm $(wc -c <"$out/zstd.wasm" | tr -d ' ') bytes  sha256 $(sha256 "$out/zstd.wasm")"
}

build_g722() {
  local src="${G722_SRC:-}"
  if [ -z "$src" ] && [ -n "${MV:-}" ]; then src="$MV/ThirdParty/g722"; fi
  if [ -z "$src" ] || [ ! -f "$src/MacViewerG722.c" ]; then
    echo "g722: set G722_SRC (or MV) to MacViewer's ThirdParty/g722" >&2
    exit 1
  fi
  src="$(cd "$src" && pwd)"
  if [ "$(sha256 "$src/g722_decode.c")" != "$G722_DECODE_SHA256" ] ||
    [ "$(sha256 "$src/include/modules/third_party/g722/g722_enc_dec.h")" != "$G722_HEADER_SHA256" ]; then
    echo "g722: upstream WebRTC files in $src do not match provenance.json" >&2
    exit 1
  fi
  local exports=(_MacViewerG722Create _MacViewerG722Destroy _MacViewerG722Decode _malloc _free)
  (
    cd "$src"
    emcc -O3 -DNDEBUG \
      -I include \
      -ffile-prefix-map="$src"=g722 \
      g722_decode.c MacViewerG722.c \
      --no-entry \
      -sEXPORTED_FUNCTIONS="$(IFS=,; echo "${exports[*]}")" \
      -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
      -sINCOMING_MODULE_JS_API=wasmBinary \
      -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createG722Module \
      -sENVIRONMENT=web,worker \
      -sINITIAL_MEMORY=1MB -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=16MB -sSTACK_SIZE=64KB \
      -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 -sSUPPORT_ERRNO=0 \
      -o "$work/g722.js"
  )
  {
    echo "// GENERATED by viewer-src/scripts/build-wasm.sh. Do not edit."
    echo "// G.722 decoder: WebRTC g722_decode.c (SpanDSP, public domain; BSD, see THIRD_PARTY_NOTICES.md)"
    echo "// plus MacViewerG722.c (NAudio Int16 output-wrap compatibility), sha256 $(sha256 "$src/MacViewerG722.c")."
    echo "// Compiler: $emcc_version"
    cat "$work/g722.js"
  } >"$out/g722.js"
  cp "$work/g722.wasm" "$out/g722.wasm"
  echo "g722.js   $(wc -c <"$out/g722.js" | tr -d ' ') bytes  sha256 $(sha256 "$out/g722.js")"
  echo "g722.wasm $(wc -c <"$out/g722.wasm" | tr -d ' ') bytes  sha256 $(sha256 "$out/g722.wasm")"
}

echo "emcc: $emcc_version"
if [ "$target" = zstd ] || [ "$target" = all ]; then build_zstd; fi
if [ "$target" = g722 ] || [ "$target" = all ]; then build_g722; fi
