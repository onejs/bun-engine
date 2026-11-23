#!/bin/bash
# build static ICU 74.2 with the pinned WebKit per-item data compression on macOS
set -euo pipefail
work=${BUN_ENGINE_WORK:-$HOME/.cache/bun-engine}
here=$(cd "$(dirname "$0")" && pwd)
icu="$work/icu"
arch=${BUN_ENGINE_ARCH:-arm64}
case "$arch" in
  arm64) arch_flags=(-arch arm64) ;;
  x86_64) arch_flags=(-arch arm64 -arch x86_64) ;;
  *) exit 2 ;;
esac
mkdir -p "$icu/dl" "$icu/build"
fetch() {
  local url=$1 path=$2 sha=$3
  if [[ ! -f "$path" ]]; then
    curl -fsSL -o "$path.partial" "$url"
    printf '%s  %s\n' "$sha" "$path.partial" | shasum -a 256 -c -
    mv "$path.partial" "$path"
  fi
  printf '%s  %s\n' "$sha" "$path" | shasum -a 256 -c -
}
webkit=https://raw.githubusercontent.com/oven-sh/WebKit/de043228c294c72404a687634e1943f549f39048/icu
fetch https://github.com/unicode-org/icu/releases/download/release-74-2/icu4c-74_2-src.tgz \
  "$icu/dl/icu4c-74_2-src.tgz" 68db082212a96d6f53e35d60f47d38b962e9f9d207a74cfac78029ae8ff5e08c
fetch "$webkit/compress-data.ts" "$icu/dl/compress-data.ts" d01fe5b67691d5d6d96a9f66631bafec2049471318f71ac78ed49af9bdbfa93d
fetch "$webkit/keep-raw.txt" "$icu/dl/keep-raw.txt" 5bc256dcef00b6d62e41e3311f02b73108f52b6c715823c887deb4834876b2ce

scratch=$(mktemp -d)
restore() {
  if [[ -f "$scratch/udata.ao" ]]; then cp -p "$scratch/udata.ao" "$icu/build/common/udata.ao"; fi
  rm -rf "$scratch"
}
trap restore EXIT
cp "$icu/dl/compress-data.ts" "$scratch/"
patch -d "$scratch" -p1 < "$here/icu-compress-macho.patch"
src="$icu/dl/icu/source"
if [[ ! -d "$src" ]]; then
  tar -xzf "$icu/dl/icu4c-74_2-src.tgz" -C "$icu/dl"
  patch -d "$icu/dl/icu" -p1 < "$here/icu-udata.patch"
fi
if ! git -C "$icu/dl/icu" apply --check --reverse "$here/icu-system-timezone.patch" 2>/dev/null; then
  git -C "$icu/dl/icu" apply "$here/icu-system-timezone.patch"
fi

cd "$icu/build"
flags="${arch_flags[*]} -mmacosx-version-min=13.0 -DU_DISABLE_RENAMING=1 -DU_STATIC_IMPLEMENTATION -O2"
CFLAGS="$flags" CXXFLAGS="$flags -std=c++17" LDFLAGS="-framework CoreFoundation" "$src/runConfigureICU" MacOSX \
  --enable-static --disable-shared --with-data-packaging=static --disable-tests --disable-samples \
  --disable-extras --disable-icuio --disable-layoutex --prefix="$icu/out" > configure.log
make -j"${BUN_ENGINE_JOBS:-4}" > make.log
make install > install.log

# the build tools read ordinary ICU data. only the shipped archive needs the hook.
cp -p common/udata.ao "$scratch/udata.ao"
rm common/udata.ao
make -C common CXXFLAGS="$flags -std=c++17 -DBUN_ICU_COMPRESSED_DATA" udata.ao > patched-udata.log
lib="$icu/out/lib"
ar rcs "$lib/libicuuc.a" common/udata.ao
data="$src/data/in/icudt74l.dat"
icupkg="$icu/build/bin/icupkg"
# the embedded engine links no ICU legacy converters or transliterators
"$icupkg" -l "$data" | awk '/[.]cnv$/ || /^translit\//' > "$scratch/unused-data.txt"
"$icupkg" -r "$scratch/unused-data.txt" "$data" "$scratch/icudt74l.dat"
bun "$scratch/compress-data.ts" "$scratch/icudt74l.dat" "$lib/libicudata.a" \
  --icupkg "$icupkg" --skip "$icu/dl/keep-raw.txt" --level 15 \
  --cc "clang ${arch_flags[*]} -mmacosx-version-min=13.0" --obj-format macho
zstd_include=$(pkg-config --variable=includedir libzstd)
clang++ "${arch_flags[@]}" -mmacosx-version-min=13.0 -std=c++17 -O2 -c "$here/icu-decompress.cpp" \
  -I"$zstd_include" -o "$lib/bun-icu-hook.o"
if [[ "$arch" == x86_64 ]]; then
  for file in "$lib"/libicu{i18n,uc,data}.a "$lib/bun-icu-hook.o"; do
    lipo "$file" -thin x86_64 -output "$file.thin"
    mv "$file.thin" "$file"
  done
fi
ls -l "$lib"/libicu{i18n,uc,data}.a "$lib/bun-icu-hook.o"
