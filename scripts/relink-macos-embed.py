# links bun's darwin objects into libbun.dylib exporting the embed calls and the JSC C API
# (run on linux after bun-darwin-build.sh; icu-macos/ holds build-icu.sh's three archives)
from pathlib import Path
import os, subprocess
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
patterns = ['_bun_embed_*', '_JSValue*', '_JSObject*', '_JSString*', '_JSContextGroup*', '_JSContextGet*',
            '_JSGlobalContext*', '_JSEvaluateScript', '_JSCheckScriptSyntax', '_JSGarbageCollect', '_JSClass*',
            '_JSPropertyName*', '_JSReportExtraMemoryCost', '_kJS*']
exports = []
for p in patterns:
    exports += ['-Wl,-exported_symbol,' + p]
cmd = [str(llvm / 'clang++'), '@' + str(out / 'inputs.rsp'), '-Wl,@' + str(out / 'lazy.rsp'), '-dynamiclib',
       '--target=arm64-apple-macosx', '-mmacosx-version-min=13.0', '-mlinker-version=705', '-isysroot', str(sdk),
       '--ld-path=' + str(llvm / 'ld64.lld'), '-flto=thin', '-Wl,--lto-O3', '-Wl,-dead_strip',
       '-Wl,-alias,__mh_dylib_header,__mh_execute_header', '-Wl,-cache_path_lto,' + str(out / 'lto-cache'),
       '-Wl,-dead_strip_dylibs', *exports, '-Wl,-install_name,@rpath/libbun.dylib',
       '-Wl,-rename_segment,__DATA_DIRTY,__DATA',
       # an App Store binary's code starts on the page after its load commands, where its encryption extent begins
       '-Wl,-headerpad,0x3478', '-Wl,-adhoc_codesign', '-lresolv',
       # ios apps may not link the system icu, so the runtime carries its own
       *[str(root / 'icu-macos' / x) for x in ('libicui18n.a', 'libicuuc.a', 'libicudata.a')],
       '-o', str(out / 'libbun.dylib')]
subprocess.run(cmd, check=True)
subprocess.run([str(llvm / 'llvm-strip'), '-S', '-o', str(out / 'libbun-stripped.dylib'), str(out / 'libbun.dylib')], check=True)
