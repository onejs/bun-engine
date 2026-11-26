#!/bin/bash
# builds the macOS compiler and runtime inputs for packaging
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${BUN_ENGINE_WORK:-$HOME/.cache/bun-engine}
: "${BUN_TOOLCHAIN_LLVM:?set BUN_TOOLCHAIN_LLVM to the LLVM release bun pins, which includes ld64.lld}"
export PATH=$BUN_TOOLCHAIN_LLVM/bin:$PATH
ARCH=${BUN_ENGINE_ARCH:-arm64}
case "$ARCH" in
  arm64)
    source "$HERE/darwin-arm64-cpu.sh"
    export BUN_ENGINE_DARWIN_ARM64_CPU
    export BUN_WEBKIT_PATH="$WORK/webkit"
    export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
    TARGET=aarch64
    BUILD=darwin-release
    WEBKIT=local
    ;;
  x86_64) TARGET=x64; BUILD=darwin-x64-release; WEBKIT=prebuilt ;;
  *) exit 2 ;;
esac
cd "$WORK/bun-src"
bun scripts/build.ts --profile=release --os=darwin --arch="$TARGET" --build-dir="build/$BUILD" \
  --webkit="$WEBKIT" --osx-deployment-target=13.0 -j"${BUN_ENGINE_JOBS:-4}"
