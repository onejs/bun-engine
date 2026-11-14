#!/bin/bash
# package.sh <runtime libbun.dylib> <macOS bun compiler> <version> (run on a Mac)
# writes bun-engine-<version>-ios.tar.gz holding the directory One reads as ONE_BUN_ENGINE_DIR, and
# bun-engine-<version>-ios-symbols.tar.gz with the runtime's local symbols for symbolicating crashes
set -euo pipefail
RUNTIME=$1 COMPILER=$2 VERSION=$3
HERE=$(cd "$(dirname "$0")" && pwd)
STAGE=$(mktemp -d)
OUT=$STAGE/bun-engine
mkdir -p "$OUT/ios"
cp "$COMPILER" "$OUT/bun"
# local symbols are a quarter of the runtime; strip -x keeps the exports and the uuid crash reports name
UUID=$(dwarfdump --uuid "$RUNTIME" | awk '{print $2}')
mkdir -p "$STAGE/symbols"
cp "$RUNTIME" "$STAGE/symbols/Bun-$UUID.dylib"
xcrun strip -x -o "$STAGE/runtime.dylib" "$RUNTIME"
BUN="$OUT/bun" "$HERE/make-frameworks.sh" device "$STAGE/runtime.dylib" "$OUT/ios/iphoneos"
BUN="$OUT/bun" "$HERE/make-frameworks.sh" simulator "$STAGE/runtime.dylib" "$OUT/ios/iphonesimulator"
echo "$VERSION" > "$OUT/VERSION"
tar -C "$STAGE" -czf "bun-engine-$VERSION-ios.tar.gz" bun-engine
tar -C "$STAGE" -czf "bun-engine-$VERSION-ios-symbols.tar.gz" symbols
shasum -a 256 "bun-engine-$VERSION-ios.tar.gz"
