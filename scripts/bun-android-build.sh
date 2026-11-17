#!/bin/bash
set -euo pipefail
WORK=${BUN_ENGINE_WORK:-$HOME/.cache/bun-engine}
: "${BUN_TOOLCHAIN_LLVM:?set BUN_TOOLCHAIN_LLVM to Bun's LLVM release}"
: "${ANDROID_NDK_ROOT:?set ANDROID_NDK_ROOT to Android NDK r27c}"
export PATH="$BUN_TOOLCHAIN_LLVM/bin:$PATH"
cd "$WORK/bun-src"
bun scripts/build.ts --profile=release --os=linux --arch=aarch64 --abi=android \
  --build-dir=build/android-release "$@"
