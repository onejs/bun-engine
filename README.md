# bun-engine

Bun's ahead-of-time compiled JavaScriptCore as a React Native engine for [One](https://onestack.dev) release builds on iOS.

`bun compile` turns an app's JavaScript bundle into machine code at build time, so an iPhone runs native code where Hermes interprets bytecode. One's `OneBunEngine` pod wraps Bun's global context with React Native's own `JSCRuntime` and links the compiled program into the app.

This repo holds what is needed to build the engine: the Bun commit it builds from, our patch on top, and the build scripts. Bun itself is not vendored. The engine binaries are attached to [releases](https://github.com/onejs/bun-engine/releases).

## Release contents

`bun-engine-<version>-ios.tar.gz` unpacks to the directory One reads as `ONE_BUN_ENGINE_DIR`:

```
bun-engine/
  bun                                  macOS arm64 compiler, run by the release build
  ios/iphoneos/Bun.framework           the runtime for devices
  ios/iphoneos/BunCompat.framework     SDK gaps, and the compiled program at build time
  ios/iphonesimulator/...              the same for the simulator
  VERSION
```

An image from `bun compile` only loads in the runtime it was compiled against, so the compiler and the frameworks of one release always go together.

Compiled code normally treats built-in objects as read-only. React Native apps replace some of their members through polyfills, as FormatJS does with `Number.prototype.toLocaleString`, so One compiles with `BUN_AOT_REPLACE_WRITTEN=1`: every built-in member the program can be seen writing, including through a helper that receives the object, stays replaceable.

## Building

The runtime is Bun's macOS configuration, cross-built on Linux and relinked as a dylib that exports the embed calls and the JavaScriptCore C API, then retagged for iOS on a Mac. Keeping the macOS configuration keeps the runtime facts equal to the macOS compiler's, so the Mac's `bun compile` produces images the iOS runtime loads.

Every script reads `BUN_ENGINE_WORK` (default `~/.cache/bun-engine`). The Linux steps need `bun`, `cargo`, `ninja`, `cmake` and `BUN_TOOLCHAIN_LLVM` pointing at the LLVM release Bun pins (23.1.5 at this commit), which includes `ld64.lld`.

1. `scripts/build-icu.sh` (Mac): static ICU 74.2 with unversioned names, the version WebKit compiled against. Its data leaves out converters, transliteration, spoof checking and stringprep, which the runtime links no code for. iOS apps may not link the system `libicucore` (ITMS 90338). Copy `icu/out/lib/libicu{i18n,uc,data}.a` to `$BUN_ENGINE_WORK/icu-macos/` on the Linux host.
2. `scripts/setup.sh` (Linux): clones Bun at `BUN_COMMIT` and applies `patches/`.
3. `scripts/bun-darwin-build.sh` (Linux): cross-builds Bun for macOS arm64. Its `build/darwin-release/bun` is the compiler.
4. `scripts/relink-macos-embed.py` (Linux): links `embed-macos/libbun-stripped.dylib`, the runtime. `scripts/rebuild-runtime.sh` rebuilds the embed bindings and relinks after a patch change.
5. `scripts/package.sh <libbun-stripped.dylib> <bun> <version>` (Mac): runs `make-frameworks.sh` for device and simulator and writes the release tarball.

`make-frameworks.sh` retags the dylib for iOS (`dylib-template.py`), points the symbols the iOS SDK lacks at BunCompat (`patch-imports.py`, `ios-compat.c`) and adds the `LC_ENCRYPTION_INFO_64` command App Store validation requires (`encryption-info.py`). The runtime links with a header pad so its code starts at offset 0x4000, where Apple's linker puts it.

## App Store

Team Machine shipped to TestFlight on this engine. Validation and processing require:

- One executable segment per binary (ITMS 90999). One's build links the compiled program into `BunCompat.framework` as `__TEXT,__bun` instead of `bun compile`'s `__BUN` segment.
- `LC_ENCRYPTION_INFO_64` with Apple's extents (90125, 90180).
- No system ICU (90338).

## Licenses

The scripts and patch are MIT. The binaries contain [Bun](https://github.com/oven-sh/bun) (MIT) at `BUN_COMMIT`, Oven's [WebKit fork](https://github.com/oven-sh/WebKit) at the commit that Bun commit pins (JavaScriptCore is LGPL 2.1 and BSD), and [ICU 74.2](https://github.com/unicode-org/icu) (Unicode license).
