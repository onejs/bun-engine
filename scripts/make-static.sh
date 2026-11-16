#!/bin/bash
# make-static.sh <stage dir> <out dir> (run on a Mac)
# prelinks a staged relink (stage-inputs.sh) into ios/<platform>/BunEngine.o: one object exporting only
# the embed calls and the JavaScriptCore C API, with ICU and the iOS SDK gaps inside, and writes
# ios/BunEngine.tbd, the same exports for linking a debug build that ships no runtime
set -euo pipefail
STAGE=$(cd "$1" && pwd)
mkdir -p "$2" && OUT=$(cd "$2" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp "$HERE/../embed.h" "$OUT/embed.h"
cd "$STAGE"
# ld -r keeps MH_SUBSECTIONS_VIA_SYMBOLS only when every input has it, and dead stripping needs it
mkdir -p "$WORK/eager" "$WORK/lazy"
while read -r f; do cp "$f" "$WORK/eager/"; done < eager.txt
while read -r f; do cp "lazy/$f" "$WORK/lazy/"; done < lazy.txt
python3 "$HERE/subsections.py" "$WORK"/eager/*.o "$WORK"/lazy/*
(cd "$WORK/lazy" && ls | xcrun libtool -static -no_warning_for_no_symbols -o "$WORK/lazy.a" -filelist /dev/stdin)
ls "$WORK"/eager/*.o > "$WORK/eager.txt"
xcrun ld -r -arch arm64 -platform_version macos 13.0 26.5 -exported_symbols_list exports.txt \
  -filelist "$WORK/eager.txt" "$WORK/lazy.a" -o "$WORK/engine-macos.o"
for p in iphonesimulator:7:ios-simulator:arm64-apple-ios17.0-simulator iphoneos:2:ios:arm64-apple-ios17.0; do
  IFS=: read -r sdk number platform target <<< "$p"
  mkdir -p "$OUT/ios/$sdk"
  python3 "$HERE/finish-object.py" "$WORK/engine-macos.o" features.json removed-features.txt "$WORK/engine-$sdk.o" "$number"
  xcrun --sdk "$sdk" clang -target "$target" -O2 -c "$HERE/ios-compat.c" -o "$WORK/compat-$sdk.o"
  xcrun ld -r -arch arm64 -platform_version "$platform" 17.0 27.1 -exported_symbols_list exports.txt \
    "$WORK/engine-$sdk.o" "$WORK/compat-$sdk.o" -o "$OUT/ios/$sdk/BunEngine.o"
done
python3 "$HERE/exports-tbd.py" "$OUT/ios/iphoneos/BunEngine.o" > "$OUT/ios/BunEngine.tbd"
ls -la "$OUT"/ios/*/BunEngine.o "$OUT/ios/BunEngine.tbd"
