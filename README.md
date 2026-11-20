# bun-engine

Bun's ahead-of-time compiled JavaScriptCore as a React Native engine for [One](https://onestack.dev) release builds on iOS.

`bun compile` turns an app's JavaScript bundle into machine code at build time, so an iPhone runs native code where Hermes interprets bytecode. One's `OneBunEngine` pod wraps Bun's global context with React Native's own `JSCRuntime` and links the compiled program into the app.

This repo holds what is needed to build the engine: the Bun commit it builds from, our patch on top, and the build scripts. Bun itself is not vendored. The engine binaries are attached to [releases](https://github.com/onejs/bun-engine/releases).

## Release contents

`bun-engine-<version>-ios.tar.gz` unpacks to the directory One reads as `ONE_BUN_ENGINE_DIR`:

```
bun-engine/
  bun                             macOS arm64 compiler, run by the release build
  ios/iphoneos/BunEngine.o        the runtime for devices, one prelinked object
  ios/iphonesimulator/BunEngine.o the same for the simulator
  ios/BunEngine.tbd               the runtime's exports, for debug builds that ship no runtime
  VERSION
```

The app executable links `BunEngine.o` statically, so no Bun image loads before `main`. An image from `bun compile` only loads in the runtime it was compiled against, so the compiler and the objects of one release always go together. A program is bound to its runtime by the stamp and identity (the executable's `LC_UUID`) in its image header and holds no runtime addresses, so One compiles it against a template executable before the app links and writes the app's identity into it after.

Compiled code normally treats built-in objects as read-only. React Native apps replace some of their members through polyfills, as FormatJS does with `Number.prototype.toLocaleString`, so One compiles with `BUN_AOT_REPLACE_WRITTEN=1`: every built-in member the program can be seen writing, including through a helper that receives the object, stays replaceable.

One compiles device programs with `--aot-huge-heap`, whose references reach any address. The runtime reserves its 32 GB heap cage only for a program compiled without it (One's simulator builds), so a device app needs no extended virtual addressing for its heap.

## Building

The runtime is Bun's macOS configuration, cross-built on Linux, then prelinked on a Mac into one object that exports the embed calls and the JavaScriptCore C API, retagged for iOS. Keeping the macOS configuration keeps the runtime facts equal to the macOS compiler's, so the Mac's `bun compile` produces images the iOS runtime loads.

Every script reads `BUN_ENGINE_WORK` (default `~/.cache/bun-engine`). The Linux steps need `bun`, `cargo`, `ninja`, `cmake` and `BUN_TOOLCHAIN_LLVM` pointing at the LLVM release Bun pins (23.1.5 at this commit), which includes `ld64.lld`.

1. `scripts/build-icu.sh` (Mac): static ICU 74.2 with unversioned names, the version WebKit compiled against. iOS apps may not link the system `libicucore` (ITMS 90338), so the runtime carries its own, kept small two ways. Its data is built from source through `scripts/icu-filter.json`, which leaves out what JavaScript cannot reach: converters, transliteration, rule-based number formats, units outside ECMA-402's sanctioned list, grammatical case and gender, exemplar cities and the like. Collation is compiled out, and `scripts/icu-foundation/` answers JavaScriptCore's collation and display-name calls from CoreFoundation under ICU's names. That takes ICU's data from 24 MB to under 10 MB. Copy `icu/out/lib/libicu{-foundation,i18n,uc,data}.a` to `$BUN_ENGINE_WORK/icu-macos/` on the Linux host.
2. `scripts/setup.sh` (Linux): clones Bun at `BUN_COMMIT` and applies `patches/`.
3. `scripts/bun-darwin-build.sh` (Linux): cross-builds Bun for macOS arm64. Its `build/darwin-release/bun` is the compiler.
4. `scripts/relink-macos-embed.py --remove scripts/removed-features.txt` (Linux): links `embed-macos/libbun.dylib`, the macOS runtime, without the features React Native cannot reach (below). Add `--reuse-trim` when changing only the removal list: it reuses the existing trim analysis and compiled objects and relinks natively with no Bun rebuild or LTO. Rerun without that flag after changing compiled Bun objects. Without `--remove` it links every feature. `scripts/rebuild-runtime.sh` rebuilds the embed bindings and relinks after a patch change.
5. `scripts/stage-inputs.sh` (Linux): stages the native objects of step 4's link, without debug info, in `$BUN_ENGINE_WORK/stage.tar.zst`. Copy it to the Mac and unpack it.
6. `scripts/package.sh <stage> <bun> <version>` (Mac): runs `make-static.sh` and writes the release tarball.

`make-static.sh` prelinks the staged objects with Apple's `ld -r` (LLVM's `ld64.lld` has no `-r`) into one object exporting only the embed calls and the JavaScriptCore C API. Every other symbol becomes local, so the runtime's own WebKit, ICU and Rust symbols cannot collide with the app's. `subsections.py` marks data-only objects splittable first, since `ld -r` keeps `MH_SUBSECTIONS_VIA_SYMBOLS`, which dead stripping needs, only when every input has it. `finish-object.py` marks the removed features and retags the object for iOS, and `ios-compat.c` fills the iOS SDK's gaps inside it. `exports-tbd.py` writes the stub debug builds link weakly.

## Android runtime

Build the ARM64 Android runtime on Linux with `scripts/bun-android-build.sh`, using Android NDK r27c through `ANDROID_NDK_ROOT` and the same LLVM release as the macOS build. After the objects exist, run `scripts/relink-android-embed.py`. It reuses those objects and the build system's expanded link command, producing `$BUN_ENGINE_WORK/embed-android/libbun.so` with only the embed calls and JavaScriptCore C API exported. The ELF load segments use 16 KB alignment. Later binding changes need only their affected objects rebuilt and this relink.

Android uses WebKit's static ICU libraries and data from the Android build. The Apple CoreFoundation substitutions apply only to iOS. One reads the Android library at `android/arm64-v8a/libbun.so` and its JavaScriptCore C headers at `android/include/JavaScriptCore` under the engine directory.

The Android runtime and its compiler must have matching revisions, built-in module text and JavaScriptCore layout facts. The macOS compiler does not accept the Android runtime merely because their revisions match. Package the matching Android compiler from `build/android-release/bun` with `scripts/stage-android-compiler.py`. The [build-host runner](docs/android-compiler.md) executes it on macOS through Docker and on Linux through QEMU user mode, preserving every compatibility check without rebuilding Bun.

## Removed features

The runtime leaves out 126 of Bun's removable features: compiling and tooling, which `bun compile` removes from every program anyway, and Bun and Node APIs a React Native app cannot reach because it never imports them and Hermes lacks them too (servers, database clients, processes, sockets, Node modules, WebAssembly, release diagnostics, the bundler and transpiler). `scripts/removed-features.txt` lists them. Web globals such as `fetch`, `WebSocket`, `TextEncoder` and `URL` stay, since React Native's polyfills read every global they replace, and `bun:sqlite` stays for One's database.

Bun's `--trim` cuts code out of a linked image, which splits `__TEXT` into several executable segments that App Store validation rejects. `trim-entry-points.ts` reads Bun's trim graph and writes exact symbol records, including the required stub kind. The text review report truncates long C++ names and is unsuitable as linker input. `strip_features.py` retargets removed entry points to traps or default-return stubs and links the compiled objects natively with `-dead_strip`. Entry points shared with retained features, or folded with unmarked code, stay. The feature state marks removed features so their guards take the removed path.

With the static object linked by Apple's linker and dead stripped to the embed and JSC exports (decimal MB):

| Runtime | Raw | Gzip |
| --- | ---: | ---: |
| 0.2.1 | 92.5 MB | 33.4 MB |
| Exact removal records and 128 features, original ICU | 67.4 MB | 26.4 MB |
| With filtered ICU and CoreFoundation | 52.6 MB | 20.0 MB |

B3 drops out and Wasm is down to 0.19 MB of shared runtime support.

Potential Bun upstream hooks are a stable machine-readable entry-point export from the trim linker and an option to relink an existing trim graph. The scripts currently import the trim modules from the pinned Bun source. Built-in module sources remain in one data blob with compiled-in offsets; emitting them through separate symbol references would let the linker drop unused Node module sources without rebuilding Bun.

## App Store

Team Machine shipped to TestFlight on this engine. Validation and processing require:

- One executable segment per binary (ITMS 90999). One's build links the compiled program into the app executable as `__TEXT,__bun` instead of `bun compile`'s `__BUN` segment.
- `LC_ENCRYPTION_INFO_64` with Apple's extents, supplied by the device app link.
- No system ICU (90338).

## Licenses

The scripts and patch are MIT. The binaries contain [Bun](https://github.com/oven-sh/bun) (MIT) at `BUN_COMMIT`, Oven's [WebKit fork](https://github.com/oven-sh/WebKit) at the commit that Bun commit pins (JavaScriptCore is LGPL 2.1 and BSD), and [ICU 74.2](https://github.com/unicode-org/icu) (Unicode license).
