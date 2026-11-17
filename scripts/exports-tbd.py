# exports-tbd.py <BunEngine.o>: a text stub of the object's exports, for a debug build to link
# weakly against while it ships no runtime
import subprocess, sys
names = sorted(l.split()[-1] for l in subprocess.run(['nm', '-gUj', sys.argv[1]], capture_output=True, text=True, check=True).stdout.split('\n') if l)
symbols = ', '.join(f"'{n}'" for n in names)
print(f"""--- !tapi-tbd
tbd-version: 4
targets: [ arm64-ios, arm64-ios-simulator ]
install-name: '@rpath/BunEngine.framework/BunEngine'
exports:
  - targets: [ arm64-ios, arm64-ios-simulator ]
    symbols: [ {symbols} ]
...""")
