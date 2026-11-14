#!/bin/bash
# after editing the embed bindings: rebuilds that object and relinks the runtime dylib
set -euo pipefail
WORK=${BUN_ENGINE_WORK:-$HOME/.cache/bun-engine}
: "${BUN_TOOLCHAIN_LLVM:?set BUN_TOOLCHAIN_LLVM to the LLVM release bun pins}"
export PATH=$BUN_TOOLCHAIN_LLVM/bin:$PATH
(cd "$WORK/bun-src/build/darwin-release" && ninja obj/unified/UnifiedSource-src_jsc_bindings-5.cpp.o)
python3 "$(dirname "$0")/relink-macos-embed.py"
