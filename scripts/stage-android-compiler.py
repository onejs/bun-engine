#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import shutil


parser = argparse.ArgumentParser(description='Stage the Android compiler and matching bionic runtime for build hosts.')
parser.add_argument('--bun', type=Path, required=True)
parser.add_argument('--android-root', type=Path, required=True)
parser.add_argument('--notice', type=Path, required=True, help='License notices from the Android system image')
parser.add_argument('--source', required=True, help='Android system image package, revision and build ID')
parser.add_argument('--output', type=Path, required=True, help='Engine release android/ directory')
args = parser.parse_args()
root = args.android_root
runtime = root / 'apex/com.android.runtime'
inputs = {
    'bun': args.bun,
    'linker64': runtime / 'bin/linker64',
    'bionic/libc.so': runtime / 'lib64/bionic/libc.so',
    'bionic/libm.so': runtime / 'lib64/bionic/libm.so',
    'bionic/libdl.so': runtime / 'lib64/bionic/libdl.so',
    'apex/com.android.tzdata/etc/tz/tzdata': root / 'apex/com.android.tzdata/etc/tz/tzdata',
    'NOTICE.xml.gz': args.notice,
}
for name, source in inputs.items():
    if not source.is_file():
        parser.error(f'missing {source}')
    if name in ('bun', 'linker64', 'bionic/libc.so', 'bionic/libm.so', 'bionic/libdl.so'):
        with source.open('rb') as file:
            header = file.read(20)
        if header[:6] != b'\x7fELF\x02\x01' or header[18:20] != b'\xb7\x00':
            parser.error(f'{source} must be an ARM64 little-endian ELF binary')
compiler = args.output / 'compiler'
hashes = {}
for name, source in inputs.items():
    destination = compiler / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(0o755 if name in ('bun', 'linker64') else 0o644)
    hashes[name] = hashlib.sha256(destination.read_bytes()).hexdigest()
config = compiler / 'linkerconfig/ld.config.txt'
config.parent.mkdir(parents=True, exist_ok=True)
config.write_text('dir.default = /compiler\n[default]\nnamespace.default.isolated = false\nnamespace.default.search.paths = /compiler/bionic\n')
hashes['linkerconfig/ld.config.txt'] = hashlib.sha256(config.read_bytes()).hexdigest()
(compiler / 'manifest.json').write_text(json.dumps({'android_source': args.source, 'sha256': hashes}, indent=2) + '\n')
shutil.copyfile(Path(__file__).with_name('compile-android.py'), args.output / 'compile')
(args.output / 'compile').chmod(0o755)
