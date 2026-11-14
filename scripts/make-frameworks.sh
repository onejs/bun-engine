#!/bin/bash
# make-frameworks.sh <simulator|device> <macos runtime dylib> <out dir> [program.js]
# writes Bun.framework (the runtime, with the program when given) and BunCompat.framework
set -euo pipefail
PLATFORM=$1 RUNTIME=$2 OUT=$3 PROGRAM=${4:-}
I=$(cd "$(dirname "$0")" && pwd)
BUN=${BUN:?set BUN to the macOS bun compiler from the same build}
case "$PLATFORM" in
  simulator) TARGET=arm64-apple-ios17-simulator SDK=iphonesimulator PLAT=7 FLAGS=() SYMS=(___clear_cache __NSGetMachExecuteHeader) ;;
  device) TARGET=arm64-apple-ios17 SDK=iphoneos PLAT=2 FLAGS=(--aot-huge-heap) SYMS=(___clear_cache __NSGetMachExecuteHeader _pthread_jit_write_protect_np) ;;
esac
ID=@rpath/Bun.framework/Bun
COMPAT=@rpath/BunCompat.framework/BunCompat
plist() { cat <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>$1</string>
<key>CFBundleIdentifier</key><string>dev.onestack.$1</string>
<key>CFBundleName</key><string>$1</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>17.0</string>
<key>CFBundleSupportedPlatforms</key><array><string>$( [ $PLATFORM = device ] && echo iPhoneOS || echo iPhoneSimulator )</string></array>
</dict></plist>
P
}
rm -rf "$OUT/Bun.framework" "$OUT/BunCompat.framework"
mkdir -p "$OUT/Bun.framework" "$OUT/BunCompat.framework"
SDKPATH=$(xcrun --sdk $SDK --show-sdk-path)
xcrun clang -target $TARGET -isysroot "$SDKPATH" -include TargetConditionals.h -dynamiclib "$I/ios-compat.c" -install_name $COMPAT -o "$OUT/BunCompat.framework/BunCompat"
plist BunCompat > "$OUT/BunCompat.framework/Info.plist"
B="$OUT/Bun.framework/Bun"
xcrun vtool -set-build-version $PLAT 17.0 27.1 -replace -output "$B" "$RUNTIME" 2>/dev/null
xcrun install_name_tool -id $ID "$B" 2>/dev/null
if [ -n "$PROGRAM" ]; then
  python3 "$I/dylib-template.py" "$B" prepare
  "$BUN" compile "$PROGRAM" ${FLAGS[@]+"${FLAGS[@]}"} --compile-executable-path="$B" --outfile="$B.compiled" | tail -1
  mv "$B.compiled" "$B"
  python3 "$I/dylib-template.py" "$B" restore $ID
fi
python3 "$I/patch-imports.py" "$B" $COMPAT "${SYMS[@]}" > /dev/null
python3 "$I/encryption-info.py" "$B"
plist Bun > "$OUT/Bun.framework/Info.plist"
codesign -f -s - "$OUT/BunCompat.framework" "$OUT/Bun.framework" 2>/dev/null
echo "$OUT/Bun.framework $(( $(stat -f %z "$B") / 1048576 )) MB"
