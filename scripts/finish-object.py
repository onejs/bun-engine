# finish-object.py <macos engine.o> <features.json> <removed-features.txt> <out.o> <platform number>
# marks removed features in _Bun__removableFeatureState (as strip_features.mark_removed does for the dylib)
# and retags the object's LC_BUILD_VERSION for ios 17.0
import json, struct, subprocess, sys
src, features, removed_file, out, platform = sys.argv[1:6]
b = bytearray(open(src, 'rb').read())
sections, off = [], 32
for _ in range(struct.unpack_from('<I', b, 16)[0]):
    cmd, size = struct.unpack_from('<II', b, off)
    if cmd == 0x19:
        for s in range(struct.unpack_from('<I', b, off + 64)[0]):
            at = off + 72 + 80 * s
            addr, sz, fileoff = struct.unpack_from('<QQI', b, at + 32)
            sections.append((addr, sz, fileoff))
    elif cmd == 0x32:
        struct.pack_into('<III', b, off + 8, int(platform), 17 << 16, 27 << 16 | 1 << 8)
    off += size
nm = subprocess.run(['nm', '-m', src], capture_output=True, text=True, check=True).stdout
addr = next(int(l.split()[0], 16) for l in nm.splitlines() if l.endswith(' _Bun__removableFeatureState'))
at = next(fo + addr - a for a, sz, fo in sections if a <= addr < a + sz)
assert b[at:at + 8] == b'BUNFEAT\0', 'feature state is not at its symbol'
index = {f['name']: f['index'] for f in json.load(open(features))['features']}
removed = [l.split('#')[0].strip() for l in open(removed_file) if l.split('#')[0].strip()]
for name in removed:
    b[at + 24 + index[name]] = 1
open(out, 'wb').write(b)
print(f'{out}: {len(removed)} features marked removed')
