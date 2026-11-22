#!/bin/bash
# static icu 74.2 for the ios runtime (run on a Mac). webkit compiled against 74 with unversioned names, and ios
# apps may not link the system libicucore (ITMS 90338), so the runtime carries its own. to keep it small:
# - the data is built from source through icu-filter.json, leaving out what javascript cannot reach
# - collation is compiled out, and collation and locale display names come from CoreFoundation instead
#   (icu-foundation/, under the icu names javascriptcore calls). icu's own display names api is renamed,
#   since its time zone names still use the c++ class
set -euo pipefail
WORK=${BUN_ENGINE_WORK:-$HOME/.cache/bun-engine}
HERE=$(cd "$(dirname "$0")" && pwd)
I=$WORK/icu
mkdir -p "$I/dl" "$I/build"
fetch() { # <file> <sha256>
  [ -f "$I/dl/$1" ] || curl -fsSL -o "$I/dl/$1" "https://github.com/unicode-org/icu/releases/download/release-74-2/$1"
  echo "$2  $I/dl/$1" | shasum -a 256 -c -
}
fetch icu4c-74_2-src.tgz 68db082212a96d6f53e35d60f47d38b962e9f9d207a74cfac78029ae8ff5e08c
fetch icu4c-74_2-data.zip c28c3ca5f4ba3384781797138a294ca360988d4322674ad4d51e52f5d9b0a2b6
if [ ! -d "$I/src/icu" ]; then
  mkdir -p "$I/src"
  tar -xzf "$I/dl/icu4c-74_2-src.tgz" -C "$I/src"
  # the source tarball carries only prebuilt data; the filter needs the data sources
  rm -rf "$I/src/icu/source/data"
  (cd "$I/src/icu/source" && unzip -q "$I/dl/icu4c-74_2-data.zip")
fi
RENAME=""
for f in close getContext getDialectHandling getLocale keyDisplayName keyValueDisplayName languageDisplayName localeDisplayName \
  open openForContext regionDisplayName scriptCodeDisplayName scriptDisplayName variantDisplayName; do
  RENAME="$RENAME -Duldn_$f=icu_uldn_$f"
done
F="-arch arm64 -mmacosx-version-min=13.0 -DU_DISABLE_RENAMING=1 -DU_STATIC_IMPLEMENTATION -DUCONFIG_NO_COLLATION=1$RENAME -O2"
cd "$I/build"
ICU_DATA_FILTER_FILE="$HERE/icu-filter.json" CFLAGS="$F" CXXFLAGS="$F -std=c++17" "$I/src/icu/source/runConfigureICU" MacOSX \
  --enable-static --disable-shared --with-data-packaging=archive --disable-tests --disable-samples --disable-extras \
  --disable-icuio --disable-layoutex --prefix="$I/out" > configure.log
make -j"$(sysctl -n hw.ncpu)" > make.log
make install > install.log
# genbrk needs character names and icu's init needs converter aliases while the data builds; the runtime needs neither
export DYLD_LIBRARY_PATH="$I/build/lib"
mkdir -p "$I/slim"
printf 'unames.icu\ncnvalias.icu\n' > "$I/slim/remove.txt"
"$I/build/bin/icupkg" --ignore-deps -r "$I/slim/remove.txt" "$I/build/data/out/icudt74l.dat" "$I/slim/icudt74l.dat"
"$I/build/bin/genccode" -e icudt74 -a gcc-darwin -d "$I/slim" "$I/slim/icudt74l.dat"
clang -c -arch arm64 -mmacosx-version-min=13.0 "$I/slim/icudt74l_dat.S" -o "$I/slim/icudt74l_dat.o"
rm -f "$I/out/lib/libicudata.a"
ar rcs "$I/out/lib/libicudata.a" "$I/slim/icudt74l_dat.o"
mkdir -p "$I/foundation"
for c in "$HERE"/icu-foundation/*.c; do
  clang -c -O2 -arch arm64 -mmacosx-version-min=13.0 -DU_DISABLE_RENAMING=1 -DU_STATIC_IMPLEMENTATION -I"$I/out/include" \
    "$c" -o "$I/foundation/$(basename "${c%.c}").o"
done
rm -f "$I/out/lib/libicu-foundation.a"
ar rcs "$I/out/lib/libicu-foundation.a" "$I"/foundation/*.o
ls -la "$I/out/lib/"libicu{-foundation,i18n,uc,data}.a
