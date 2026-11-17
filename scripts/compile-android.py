#!/usr/bin/env python3
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile


parser = argparse.ArgumentParser(description='Compile a Metro bundle with the matching Android Bun compiler.')
parser.add_argument('operation', choices=['compile'])
parser.add_argument('bundle', type=Path)
parser.add_argument('--loader', default='.bundle:js', choices=['.bundle:js'])
parser.add_argument('--compile-executable-path', type=Path, required=True, dest='template')
parser.add_argument('--outfile', type=Path, required=True, dest='output')
args = parser.parse_args()
android = Path(__file__).resolve().parent
compiler = android / 'compiler'
template = args.template.resolve()
for required in [args.bundle, template, compiler / 'bun', compiler / 'linker64', compiler / 'manifest.json']:
    if not required.is_file():
        parser.error(f'missing {required}')
args.output = args.output.resolve()
args.output.parent.mkdir(parents=True, exist_ok=True)

with tempfile.TemporaryDirectory(prefix='.bun-android-', dir=args.output.parent) as temporary:
    work = Path(temporary)
    shutil.copyfile(args.bundle, work / 'index.android.bundle')
    command = ['compile', './index.android.bundle', '--loader', '.bundle:js',
               f'--compile-executable-path={template}', f'--outfile={work / "compiled.so"}']
    environment = os.environ.copy()
    if platform.system() == 'Linux':
        qemu = shutil.which('qemu-aarch64')
        if not qemu:
            parser.error('install qemu-user (qemu-aarch64) to compile Android Bun images on Linux')
        executable = [qemu, '-L', str(compiler), '-E', f'LD_LIBRARY_PATH={compiler / "bionic"}',
                      '-E', 'BUN_AOT_REPLACE_WRITTEN=1', str(compiler / 'linker64'), str(compiler / 'bun')]
        subprocess.run([*executable, *command], cwd=work, env=environment, check=True)
    elif platform.system() == 'Darwin':
        manifest = (compiler / 'manifest.json').read_bytes()
        tag = 'one-bun-android-compiler:' + hashlib.sha256(manifest + Path(__file__).read_bytes()).hexdigest()
        if not shutil.which('docker'):
            parser.error('start Docker Desktop or Colima to compile Android Bun images on macOS')
        present = subprocess.run(['docker', 'image', 'inspect', tag], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        if present.returncode:
            archive = work / 'compiler.tar'
            with tarfile.open(archive, 'w') as tar:
                tar.add(compiler, arcname='compiler')
                tar.add(compiler / 'apex', arcname='apex')
                tar.add(compiler / 'linkerconfig', arcname='linkerconfig')
                directory = tarfile.TarInfo('tmp')
                directory.type = tarfile.DIRTYPE
                directory.mode = 0o1777
                tar.addfile(directory)
            subprocess.run(['docker', 'import', '--platform', 'linux/arm64', str(archive), tag], check=True)
            archive.unlink()
        container = subprocess.check_output([
            'docker', 'create', '--platform', 'linux/arm64', '--network', 'none',
            '--workdir', '/work', '--env', 'BUN_AOT_REPLACE_WRITTEN=1',
            '--env', 'LD_LIBRARY_PATH=/compiler/bionic',
            '--entrypoint', '/compiler/linker64', tag, '/compiler/bun',
            'compile', './index.android.bundle', '--loader', '.bundle:js',
            '--compile-executable-path=/work/libbun.so', '--outfile=/work/compiled.so',
        ], text=True).strip()
        try:
            subprocess.run(['docker', 'cp', str(work) + '/.', container + ':/work'], check=True)
            subprocess.run(['docker', 'cp', str(template), container + ':/work/libbun.so'], check=True)
            subprocess.run(['docker', 'start', '--attach', container], check=True)
            status = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.ExitCode}}', container], text=True).strip()
            if status != '0':
                raise SystemExit(f'Android Bun compiler exited {status}')
            subprocess.run(['docker', 'cp', container + ':/work/compiled.so', str(work / 'compiled.so')], check=True)
        finally:
            subprocess.run(['docker', 'rm', '--force', container], check=True, stdout=subprocess.DEVNULL)
    else:
        parser.error('Android Bun compilation supports macOS and Linux build hosts')
    os.replace(work / 'compiled.so', args.output)
