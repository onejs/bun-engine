#!/bin/bash
# static icu 74.2 for the ios runtime (run on a Mac). webkit compiled against 74 with unversioned names,
# and ios apps may not link the system libicucore (ITMS 90338), so the runtime carries its own
set -euo pipefail
WORK=${BUN_ENGINE_WORK:-$HOME/.cache/bun-engine}
I=$WORK/icu
mkdir -p "$I/dl" "$I/build"
T=$I/dl/icu4c-74_2-src.tgz
[ -f "$T" ] || curl -fsSL -o "$T" https://github.com/unicode-org/icu/releases/download/release-74-2/icu4c-74_2-src.tgz
echo "68db082212a96d6f53e35d60f47d38b962e9f9d207a74cfac78029ae8ff5e08c  $T" | shasum -a 256 -c -
[ -d "$I/dl/icu" ] || tar -xzf "$T" -C "$I/dl"
cd "$I/build"
F="-arch arm64 -mmacosx-version-min=13.0 -DU_DISABLE_RENAMING=1 -DU_STATIC_IMPLEMENTATION -O2"
CFLAGS="$F" CXXFLAGS="$F -std=c++17" "$I/dl/icu/source/runConfigureICU" MacOSX --enable-static --disable-shared \
  --with-data-packaging=static --disable-tests --disable-samples --disable-extras --disable-icuio --disable-layoutex \
  --prefix="$I/out" > configure.log
make -j"$(sysctl -n hw.ncpu)" > make.log
make install > install.log
ls -la "$I/out/lib/"libicu{i18n,uc,data}.a
