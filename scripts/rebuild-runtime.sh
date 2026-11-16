#!/bin/bash
# after editing the embed bindings: rebuilds that object and relinks the runtime dylib
set -euo pipefail
WORK=${BUN_ENGINE_WORK:-$HOME/.cache/bun-engine}
: "${BUN_TOOLCHAIN_LLVM:?set BUN_TOOLCHAIN_LLVM to the LLVM release bun pins}"
export PATH=$BUN_TOOLCHAIN_LLVM/bin:$PATH
(cd "$WORK/bun-src/build/darwin-release" && runtime_archive=$(sed -n 's/.*\(rust-target\/[^ ]*\/libbun_runtime-[^ ]*\.rlib\).*/\1/p' build.ninja | sed -n '1p')
  test -n "$runtime_archive"
  ninja -j "${BUN_ENGINE_JOBS:-4}" obj/src/jsc/bindings/bindings.cpp.o "$runtime_archive")
bun "$(dirname "$0")/relink-macos-embed.ts"
