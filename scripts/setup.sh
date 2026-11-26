#!/bin/bash
# clones bun at the pinned commit into $BUN_ENGINE_WORK/bun-src and applies the patches
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${BUN_ENGINE_WORK:-$HOME/.cache/bun-engine}
mkdir -p "$WORK"
[ -d "$WORK/bun-src" ] || git clone --filter=blob:none https://github.com/oven-sh/bun.git "$WORK/bun-src"
cd "$WORK/bun-src"
bun_commit=$(cat "$HERE/BUN_COMMIT")
if [[ $(git rev-parse HEAD) != "$bun_commit" ]]; then
  git checkout -q "$bun_commit"
fi
for p in "$HERE"/patches/*.patch; do
  git apply --check -R "$p" 2>/dev/null || git apply "$p"
done

if [[ ${BUN_ENGINE_ARCH:-arm64} == arm64 ]]; then
  webkit=$(bun -e 'import { WEBKIT_VERSION } from "./scripts/build/deps/webkit.ts"; console.log(WEBKIT_VERSION)')
  if [[ ! -d "$WORK/webkit/.git" ]]; then
    git init "$WORK/webkit"
    git -C "$WORK/webkit" remote add origin https://github.com/oven-sh/WebKit.git
    git -C "$WORK/webkit" sparse-checkout set \
      Source/JavaScriptCore Source/WTF Source/bmalloc Tools/Scripts Tools/BuildSlaveSupport
  fi
  cd "$WORK/webkit"
  if [[ $(git rev-parse --verify HEAD 2>/dev/null) != "$webkit" ]]; then
    git fetch --depth=1 --filter=blob:none origin "$webkit"
    git checkout --detach FETCH_HEAD
  fi
  p="$HERE/scripts/webkit-arm64-baseline.patch"
  git apply --check -R "$p" 2>/dev/null || git apply "$p"
fi
