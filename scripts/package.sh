#!/bin/bash
# package.sh <runtime libbun.dylib> <macOS bun compiler> <version> (run on a Mac)
# writes bun-engine-<version>-ios.tar.gz holding the directory One reads as ONE_BUN_ENGINE_DIR
set -euo pipefail
RUNTIME=$1 COMPILER=$2 VERSION=$3
HERE=$(cd "$(dirname "$0")" && pwd)
STAGE=$(mktemp -d)
OUT=$STAGE/bun-engine
mkdir -p "$OUT/ios"
cp "$COMPILER" "$OUT/bun"
BUN="$OUT/bun" "$HERE/make-frameworks.sh" device "$RUNTIME" "$OUT/ios/iphoneos"
BUN="$OUT/bun" "$HERE/make-frameworks.sh" simulator "$RUNTIME" "$OUT/ios/iphonesimulator"
echo "$VERSION" > "$OUT/VERSION"
tar -C "$STAGE" -czf "bun-engine-$VERSION-ios.tar.gz" bun-engine
shasum -a 256 "bun-engine-$VERSION-ios.tar.gz"
