#!/usr/bin/env python3
from pathlib import Path
import json
import os
import shlex
import subprocess

root = Path(os.environ.get('BUN_ENGINE_WORK', Path.home() / '.cache/bun-engine'))
build = root / 'bun-src/build/android-release'
out = root / 'embed-android'
out.mkdir(exist_ok=True)
llvm = Path(os.environ['BUN_TOOLCHAIN_LLVM']) / 'bin'
ninja = os.environ.get('NINJA', 'ninja')
commands = json.loads(subprocess.check_output([ninja, '-C', str(build), '-t', 'compdb', '-x', 'link']))
command = next(x for x in commands if x['output'] == 'bun-profile')
args = shlex.split(command['command'])
args[args.index('-o') + 1] = str(out / 'libbun.so')
args = [x for x in args if x not in ('-pie', '-Wl,-pie') and not x.startswith(('-Wl,--version-script=', '-Wl,--export-dynamic-symbol-list='))]
patterns = ['bun_embed_*', 'BUN_COMPILED', 'JSValue*', 'JSObject*', 'JSString*',
            'JSContextGroup*', 'JSContextGet*', 'JSGlobalContext*', 'JSEvaluateScript',
            'JSCheckScriptSyntax', 'JSGarbageCollect', 'JSClass*', 'JSPropertyName*',
            'JSReportExtraMemoryCost', 'kJS*']
exports = out / 'exports.lds'
exports.write_text('{ global: ' + '; '.join(patterns) + '; local: *; };\n')
args += ['-shared', '-Wl,-soname,libbun.so', '-Wl,-Bsymbolic-functions',
         '-Wl,-z,max-page-size=16384', '-Wl,--version-script=' + str(exports),
         '-Wl,--thinlto-cache-dir=' + str(out / 'lto-cache')]
args += ['-Wl,--undefined-glob=' + x for x in patterns]
subprocess.run(args, cwd=build, check=True)
subprocess.run([str(llvm / 'llvm-strip'), '--strip-debug', str(out / 'libbun.so')], check=True)
print(out / 'libbun.so')
