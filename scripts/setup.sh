#!/bin/bash
# clones bun at the pinned commit into $BUN_ENGINE_WORK/bun-src and applies the patches
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${BUN_ENGINE_WORK:-$HOME/.cache/bun-engine}
mkdir -p "$WORK"
[ -d "$WORK/bun-src" ] || git clone --filter=blob:none https://github.com/oven-sh/bun.git "$WORK/bun-src"
cd "$WORK/bun-src"
git checkout -q "$(cat "$HERE/BUN_COMMIT")"
for p in "$HERE"/patches/*.patch; do
  git apply --check -R "$p" 2>/dev/null || git apply "$p"
done
