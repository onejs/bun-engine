# links bun's darwin objects into libbun.dylib exporting the embed calls and the JSC C API
# (run on linux after bun-darwin-build.sh; icu-macos/ holds build-icu.sh's four archives).
# --remove <features file> leaves the listed features out through strip_features.py
from pathlib import Path
import json, os, shutil, subprocess, sys
import strip_features
reuse_trim = '--reuse-trim' in sys.argv
if reuse_trim: sys.argv.remove('--reuse-trim')
root = Path(os.environ.get('BUN_ENGINE_WORK', Path.home() / '.cache/bun-engine'))
build = root / 'bun-src/build/darwin-release'
out = root / 'embed-macos'
out.mkdir(exist_ok=True)
txt = (build / 'build.ninja').read_text().replace('$\n', '')
line = next(x for x in txt.splitlines() if x.startswith('build bun-profile |'))
inputs = line.split(': link ', 1)[1].split(' | ', 1)[0].split()
(out / 'inputs.rsp').write_text('\n'.join(str((build / x).resolve()) for x in inputs))
lazy = (build / 'bun-profile.lazy.rsp').read_text().split()
(out / 'lazy.rsp').write_text('\n'.join(x if x.startswith('--') else str((build / x).resolve()) for x in lazy))
llvm = Path(os.environ['BUN_TOOLCHAIN_LLVM']) / 'bin'
# bun's darwin cross build downloads this sdk
sdk = Path(os.environ.get('MACOS_SDK', Path.home() / '.bun/build-cache/MacOSX26.5.sdk'))
# thin lto internalizes bitcode symbols a wildcard names, so c++ embed calls are listed exactly
patterns = ['_bun_embed_*', '_bun_embed_drop_locks', '_bun_embed_grab_locks', '_JSValue*', '_JSObject*', '_JSString*', '_JSContextGroup*', '_JSContextGet*',
            '_JSGlobalContext*', '_JSEvaluateScript', '_JSCheckScriptSyntax', '_JSGarbageCollect', '_JSClass*',
            '_JSPropertyName*', '_JSReportExtraMemoryCost', '_kJS*']
(out / 'exports.txt').write_text('\n'.join(patterns) + '\n')
flags = ['-Wl,@' + str(out / 'lazy.rsp'), '-dynamiclib',
         '--target=arm64-apple-macosx', '-mmacosx-version-min=13.0', '-mlinker-version=705', '-isysroot', str(sdk),
         '--ld-path=' + str(llvm / 'ld64.lld'), '-Wl,-dead_strip',
         '-Wl,-alias,__mh_dylib_header,__mh_execute_header',
         '-Wl,-dead_strip_dylibs', '-exported_symbols_list', str(out / 'exports.txt'), '-Wl,-install_name,@rpath/libbun.dylib',
         '-Wl,-rename_segment,__DATA_DIRTY,__DATA',
         # an App Store binary's code starts on the page after its load commands, where its encryption extent begins
         '-Wl,-headerpad,0x3478', '-Wl,-adhoc_codesign', '-lresolv', '-framework', 'CoreFoundation']
# ios apps may not link the system icu, so the runtime carries its own. collation and display names come from
# CoreFoundation, under the icu names, so that archive goes first (build-icu.sh)
icu = [str(root / 'icu-macos' / x) for x in ('libicu-foundation.a', 'libicui18n.a', 'libicuuc.a', 'libicudata.a')]
# bun's own release link flags. every export is c, so whole-program visibility devirtualizes safely,
# and icf needs its address-significance tables emitted during lto
lto = ['-flto=thin', '-Wl,--lto-O3', '-Wl,--lto-CGO3', '-Wl,-mllvm,-whole-program-visibility', '-fwhole-program-vtables',
       '-fforce-emit-vtables', '-Wl,-mllvm,-inline-cold-callsite-threshold=0', '-fno-keep-static-consts', '-Wl,--icf=safe']
dylib = out / 'libbun.dylib'
if len(sys.argv) < 3 or sys.argv[1] != '--remove':
    subprocess.run([str(llvm / 'clang++'), '@' + str(out / 'inputs.rsp'), *flags, *lto,
                    '-Wl,-cache_path_lto,' + str(out / 'lto-cache'), *icu, '-o', str(dylib)], check=True)
else:
    removed = [l.split('#')[0].strip() for l in open(sys.argv[2]) if l.split('#')[0].strip()]
    trim = root / 'embed-trim'
    shutil.rmtree(trim / 'strip', ignore_errors=True)
    trim.mkdir(exist_ok=True)
    # bun's trim analysis reports every feature's entry points; zero minimums so none is refused as too small
    features = json.loads((build / 'codegen/removable-features.json').read_text())
    for f in features['features']: f['minimumBytes'] = 0
    (trim / 'features.json').write_text(json.dumps(features))
    if not reuse_trim:
        subprocess.run([shutil.which('bun'), str(root / 'bun-src/scripts/build/trim/link.ts'), str(trim / 'trim-work'),
                        str(trim / 'features.json'), str(build / 'codegen/builtin-uses.json'), '--demangler=' + str(llvm / 'llvm-cxxfilt'),
                        '--', str(llvm / 'clang++'), '@' + str(out / 'inputs.rsp'), *flags, *lto,
                        '-Wl,-cache_path_lto,' + str(trim / 'lto-cache'), *icu, '-Wl,-map,' + str(trim / 'libbun.map'),
                        '-o', str(trim / 'libbun.dylib')], check=True)
    if not reuse_trim or not (trim / 'entry-points.json').exists():
        subprocess.run([shutil.which('bun'), str(Path(__file__).with_name('trim-entry-points.ts'))],
                       env={**os.environ, 'BUN_ENGINE_WORK': str(root.resolve())}, check=True)
    objs = strip_features.stage(trim, llvm, set(removed), trim / 'strip')
    def native(p): return p.startswith('--') or open(p, 'rb').read(4) not in (b'BC\xc0\xde', b'\xde\xc0\x17\x0b')
    eager = [p for p in (out / 'inputs.rsp').read_text().split() if native(p)]
    lazy = [p for p in (out / 'lazy.rsp').read_text().split() if native(p)]
    (trim / 'native.rsp').write_text('\n'.join(objs + eager + icu) + '\n')
    (trim / 'native-lazy.rsp').write_text('\n'.join(lazy) + '\n')
    native_flags = ['-Wl,@' + str(trim / 'native-lazy.rsp')] + flags[1:] + ['-Wl,--icf=safe']
    subprocess.run([str(llvm / 'clang++'), '@' + str(trim / 'native.rsp'), *native_flags, '-Wl,-map,' + str(out / 'libbun.map'), '-o', str(dylib)], check=True)
    strip_features.mark_removed(dylib, trim / 'features.json', removed, llvm)
subprocess.run([str(llvm / 'llvm-strip'), '-S', '-o', str(out / 'libbun-stripped.dylib'), str(dylib)], check=True)
