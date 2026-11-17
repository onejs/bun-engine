# Android compilation on build hosts

Run the matching Android compiler on the build host instead of changing Bun's compatibility checks. macOS uses a local ARM64 Linux container through Docker Desktop or Colima. Linux uses `qemu-aarch64` from `qemu-user`, including on ARM64, so Android's absolute paths resolve inside the packaged sysroot. Neither path needs an Android emulator, adb, a phone or a network connection during compilation. macOS needs a running Docker daemon; Linux needs QEMU user mode, not system emulation or binfmt registration. Both need Python 3.

The compiler is the unchanged `build/android-release/bun`. It runs through Android's own `linker64`, with bionic libc, libm, libdl and timezone data from a pinned ARM64 Android system image. All Bun template checks stay enabled. A container has no network and receives only the bundle and runtime template. Its output is copied back before the container is removed. The compiler image is cached by the package manifest and runner source; later builds reuse it.

## Package layout

```
android/
  compile
  compiler/
    bun
    linker64
    bionic/{libc.so,libm.so,libdl.so}
    apex/com.android.tzdata/etc/tz/tzdata
    linkerconfig/ld.config.txt
    NOTICE.xml.gz
    manifest.json
  arm64-v8a/libbun.so
  include/JavaScriptCore/
```

Build the Android compiler and runtime together using the existing Android build and relink scripts. Extract the runtime linker, bionic libraries, timezone data and license notices from one pinned Android ARM64 system image, preserving its `apex/` paths. An emulator can supply these files while preparing a release; an app build never contacts it. Keep the system-image package, revision and build fingerprint in `--source`.

```
python3 scripts/stage-android-compiler.py \
  --bun "$BUN_ENGINE_WORK/bun-src/build/android-release/bun" \
  --android-root /path/to/extracted-android-root \
  --notice /path/to/extracted-android-root/system/etc/NOTICE.xml.gz \
  --source 'system-image package, revision and build fingerprint' \
  --output /path/to/bun-engine/android
```

This copies `compile-android.py` to `android/compile` and records SHA256 hashes of the compiler and sysroot files. Include that directory alongside the matching runtime and JSC headers in the engine release. Preparing the runner needs no Bun source patch or rebuild.

The runner accepts the existing One Android build command:

```
BUN_AOT_REPLACE_WRITTEN=1 "$ONE_BUN_ENGINE_DIR/android/compile" \
  compile ./index.android.bundle --loader .bundle:js \
  --compile-executable-path="$ONE_BUN_ENGINE_DIR/android/arm64-v8a/libbun.so" \
  --outfile=/absolute/path/libbun.so
```

It supports this Metro bundle contract, not Bun's complete CLI. It stages the bundle as `index.android.bundle` on both hosts, sets the written-builtins option and replaces the requested output only after successful compilation. Install Linux's `qemu-user` package so `qemu-aarch64` is on PATH. No root access is needed to execute the runner.

## Why a stamp override is incorrect

Comparing Android and macOS compilers at Bun revision `732d8d052760694c9b6fb5778b162e3ba5951ad6` found identical three-part `BUILTIN_TABLE` hashes. The built-in module source stamps differed. Of 210 differing modules, 200 differed only in generated build-directory comments, but ten retained platform-specific code after normalizing those comments. Examples include FFI's `.so` versus `.dylib`, Android's intent launcher versus macOS `open`, glob case sensitivity and filesystem copy fast paths.

The engine descriptions each contain 1,146 facts, with 18 differing values. Android's image page size is 65,536 versus macOS's 16,384; other differences include VM and heap layout offsets. Their platform and required CPU-feature fields also differ. The image-form difference is supported by Bun's template mechanism, but replacing the platform or layout records would misdescribe the code the host compiler generates. Matching the revision or rewriting hashes cannot fix that.

At that revision, a 13-case probe compiled through the macOS and Linux runners produced byte-identical libraries. Both loaded through `bun_embed_create` and `bun_embed_run_entry` on an Android ARM64 emulator with JIT and Wasm disabled, matching native Android compilation for objects, closures, maps, sets, typed arrays, regular expressions, Unicode, JSON, Intl, dates, exceptions, written builtins and promises.

The upstream hook that would remove these host dependencies is a target-runtime description accepted by Bun's AOT driver and JSC code generator, including target built-in sources, CPU requirements, page sizes and struct offsets. Today the driver uses its compiled-in host facts. Relaxing `check_request` or `check_template` alone is insufficient. No upstream request has been filed.
