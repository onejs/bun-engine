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
  macos/arm64/BunEngine.o         the native Apple Silicon runtime
  macos/x86_64/BunEngine.o        the native Intel runtime (when an Intel stage is supplied)
  macos/x86_64/bun                the matching Intel compiler
  embed.h                         public embedding and task scheduling API
  VERSION
```

The app executable links `BunEngine.o` statically, so no Bun image loads before `main`. An image from `bun compile` only loads in the runtime it was compiled against, so the compiler and the objects of one release always go together. A program is bound to its runtime by the stamp and identity (the executable's `LC_UUID`) in its image header and holds no runtime addresses, so One compiles it against a template executable before the app links and writes the app's identity into it after.

Compiled code normally treats built-in objects as read-only. React Native apps replace some of their members through polyfills, as FormatJS does with `Number.prototype.toLocaleString`, so One compiles with `BUN_AOT_REPLACE_WRITTEN=1`: every built-in member the program can be seen writing, including through a helper that receives the object, stays replaceable.

One compiles device programs with `--aot-huge-heap`, whose references reach any address. The runtime reserves its 32 GB heap cage only for a program compiled without it (One's simulator builds), so a device app needs no extended virtual addressing for its heap.

## Building

The runtime is Bun's macOS configuration, cross-built on Linux, then prelinked on a Mac into one object that exports the embed calls and the JavaScriptCore C API, retagged for iOS. Keeping the macOS configuration keeps the runtime facts equal to the macOS compiler's, so the Mac's `bun compile` produces images the iOS runtime loads.

Every script reads `BUN_ENGINE_WORK` (default `~/.cache/bun-engine`). The Linux steps need `bun`, `cargo`, `ninja`, `cmake` and `BUN_TOOLCHAIN_LLVM` pointing at the LLVM release Bun pins (23.1.5 at this commit), which includes `ld64.lld`.

1. `scripts/build-icu.sh` (Mac): build static ICU 74.2 with unversioned names. Install Bun and the zstd CLI and development headers on the build Mac. The build uses the pinned WebKit per-item compressor. Its shared dictionary and compressed resources preserve every original ICU item. ICU loads frequently used items directly and decodes the others once, on first use. Copy `icu/out/lib/libicu{i18n,uc,data}.a` and `bun-icu-hook.o` to `$BUN_ENGINE_WORK/icu-macos/` on the Linux host.
2. `scripts/setup.sh` (Linux): clones Bun at `BUN_COMMIT` and applies `patches/`.
3. `scripts/bun-darwin-build.sh` (Linux): cross-builds Bun for macOS arm64. Its `build/darwin-release/bun` is the compiler.
4. `scripts/relink-macos-embed.ts --remove scripts/removed-features.txt` (Linux): links `embed-macos/libbun.dylib`, the macOS runtime, without the features React Native cannot reach (below). Without `--remove` it links every feature. `scripts/rebuild-runtime.sh` rebuilds the embed bindings and relinks after a patch change.
5. `scripts/stage-inputs.sh` (Linux): stages the native objects of step 4's link, without debug info, in `$BUN_ENGINE_WORK/stage.tar.zst`. Copy it to the Mac and unpack it.
6. `scripts/package.sh <stage> <bun> <version> [x86_64-stage x86_64-bun]` (Mac): runs `make-static.sh` and writes the release tarball.

`make-static.sh` prelinks the staged objects with Apple's `ld -r` (LLVM's `ld64.lld` has no `-r`) into one object exporting only the embed calls and the JavaScriptCore C API. Every other symbol becomes local, so the runtime's own WebKit, ICU and Rust symbols cannot collide with the app's. `subsections.ts` marks data-only objects splittable first, since `ld -r` keeps `MH_SUBSECTIONS_VIA_SYMBOLS`, which dead stripping needs, only when every input has it. `finish-object.ts` marks the removed features and retags the object for iOS, and `ios-compat.c` fills the iOS SDK's gaps inside it. `exports-tbd.py` writes the stub debug builds link weakly.

For an Intel macOS runtime, set `BUN_ENGINE_ARCH=x86_64` for the build, relink,
stage and static steps, with a separate `BUN_ENGINE_WORK` and architecture-matched
ICU archives. Package its stripped `build/darwin-x64-release/bun` alongside the
object as `macos/x86_64/bun` when compiling on Intel hosts. It builds
`build/darwin-x64-release` and exports only a macOS object.
The arm64 stage exports both macOS and iOS objects. `BUN_ENGINE_BUILD_DIR` selects
a prepared build directory. The public header uses a quote include path (`-iquote`),
so the release VERSION file cannot shadow the C++ `<version>` header on macOS.
Link Intel apps with `-Wl,-segalign,0x4000` to preserve the runtime's 16 KiB section
alignment; Apple Silicon already uses that segment alignment.

## Host scheduling

The main JS thread calls `bun_embed_create`, installs its globals, registers a
`bun_embed_set_wakeup` callback, then runs the entry. The Darwin callback runs
on the main queue when the runtime's kqueue becomes readable, including tasks
posted by the HTTP thread. It schedules `bun_embed_tick`; notifications coalesce
until that tick drains ready I/O, timers, tasks and microtasks without blocking.
The host also schedules a timer from `bun_embed_next_timeout`: milliseconds
until the nearest runtime timer, zero for ready work, or NaN when idle. The query
does not execute JavaScript. Timer callbacks need no display frame unless they
change the rendered tree. Passing null to `bun_embed_set_wakeup` unregisters
before the user pointer is released. The readiness API requires the main JS thread.
The declarations ship as `embed.h`.

Native callbacks which allocate through the typed-array C API bracket that work
with `bun_embed_lock(context)` and `bun_embed_unlock(context)`. JavaScriptCore
drops the API lock before invoking a class's native function callback. This fork's
typed-array allocation calls do not acquire it, so the callback must enter the VM
before allocating and keep the lock while using borrowed typed-array storage.

## Removed features

The runtime leaves out the 79 features listed in `scripts/removed-features.txt`. Web globals such as `fetch`, `WebSocket`, `TextEncoder` and `URL` remain available, along with SQLite. Compiled context restart and the host heap collection API use the same embedding contract.

Bun's `--trim` cuts code out of a linked image, which splits `__TEXT` into several executable segments that App Store validation rejects. `strip-features.ts` uses its analysis instead: The trim analysis recovers the exact entry points and their stub kinds. The native relink redirects references to removed entry points, runs `-dead_strip`, and records which feature guards should take the removed path.

## App Store

Team Machine shipped to TestFlight on this engine. Validation and processing require:

- One executable segment per binary (ITMS 90999). One's build links the compiled program into the app executable as `__TEXT,__bun` instead of `bun compile`'s `__BUN` segment.
- No system ICU (90338).

## Licenses

The scripts and patch are MIT. The binaries contain [Bun](https://github.com/oven-sh/bun) (MIT) at `BUN_COMMIT`, Oven's [WebKit fork](https://github.com/oven-sh/WebKit) at the commit that Bun commit pins (JavaScriptCore is LGPL 2.1 and BSD), and [ICU 74.2](https://github.com/unicode-org/icu) (Unicode license).
