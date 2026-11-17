#!/bin/bash
# stage-inputs.sh (run on linux after relink-macos-embed.py --remove)
# stages the native relink's inputs for make-static.sh in $BUN_ENGINE_WORK/stage.tar.zst: eager
# objects, and every native archive member for lazy.a. debug info and llvm's address-significance
# tables go, since apple's ld -r keeps __llvm_addrsig as plain data. bitcode members were compiled
# by the lto link
set -euo pipefail
W=${BUN_ENGINE_WORK:-$HOME/.cache/bun-engine}
L=${BUN_TOOLCHAIN_LLVM:?set BUN_TOOLCHAIN_LLVM}/bin
HERE=$(cd "$(dirname "$0")" && pwd)
S=$W/stage
rm -rf "$S" && mkdir -p "$S/in" "$S/lazy" "$S/x"
strip_obj() { "$L/llvm-objcopy" --strip-debug --remove-section=__DATA,__llvm_addrsig "$1" "$2"; }
native() { [ "$(head -c 4 "$1" | od -An -tx1 | tr -d ' ')" = cffaedfe ]; }
i=0
: > "$S/eager.txt"
member() {
  rm -rf "$S/x"/* && (cd "$S/x" && "$L/llvm-ar" x "$1")
  for m in "$S/x"/*; do
    i=$((i+1)); native "$m" && [ "$(basename "$m")" != lib.rmeta ] && strip_obj "$m" "$S/lazy/$(printf '%05d' $i)-$(basename "$m")"
  done
  return 0
}
while read -r f; do
  case "$f" in
    --*) ;;
    *.o) i=$((i+1)); n="in/$(printf '%05d' $i)-$(basename "$f")"; strip_obj "$f" "$S/$n"; echo "$n" >> "$S/eager.txt" ;;
    *) member "$f" ;;
  esac
done < "$W/embed-trim/native.rsp"
while read -r f; do case "$f" in --*) ;; *) i=$((i+1)); strip_obj "$f" "$S/lazy/$(printf '%05d' $i)-$(basename "$f")" ;; esac; done < "$W/embed-trim/native-lazy.rsp"
rm -rf "$S/x"
(cd "$S/lazy" && ls | sort > ../lazy.txt)
cp "$W/embed-macos/exports.txt" "$W/embed-trim/features.json" "$HERE/removed-features.txt" "$S/"
cd "$W" && tar -cf - stage | zstd -T0 -3 -q -o stage.tar.zst -f
echo "eager $(wc -l < "$S/eager.txt") lazy $(wc -l < "$S/lazy.txt")"
