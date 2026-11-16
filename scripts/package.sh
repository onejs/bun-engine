#!/bin/bash
# package.sh <stage dir> <macOS bun compiler> <version> (run on a Mac)
# writes bun-engine-<version>-ios.tar.gz holding the directory One reads as ONE_BUN_ENGINE_DIR
set -euo pipefail
STAGE_IN=$1 COMPILER=$2 VERSION=$3
X64_STAGE=${4:-} X64_COMPILER=${5:-}
HERE=$(cd "$(dirname "$0")" && pwd)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
OUT=$STAGE/bun-engine
mkdir -p "$OUT"
cp "$COMPILER" "$OUT/bun"
"$HERE/make-static.sh" "$STAGE_IN" "$OUT"
if [ -n "$X64_STAGE" ]; then
  test -n "$X64_COMPILER"
  BUN_ENGINE_ARCH=x86_64 "$HERE/make-static.sh" "$X64_STAGE" "$OUT"
  cp "$X64_COMPILER" "$OUT/macos/x86_64/bun"
fi
echo "$VERSION" > "$OUT/VERSION"
tar -C "$STAGE" -czf "bun-engine-$VERSION-ios.tar.gz" bun-engine
shasum -a 256 "bun-engine-$VERSION-ios.tar.gz"
