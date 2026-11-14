# bun compile writes only into executables: hide a dylib's LC_ID_DYLIB as a load command and put it back after
import struct, sys
path, action = sys.argv[1], sys.argv[2]
b = bytearray(open(path, 'rb').read())
off = 32
for _ in range(struct.unpack_from('<I', b, 16)[0]):
    cmd, size = struct.unpack_from('<II', b, off)
    if action == 'prepare' and cmd == 0xd:
        struct.pack_into('<I', b, off, 0xc)
        break
    if action == 'restore' and cmd == 0xc:
        at = off + struct.unpack_from('<I', b, off + 8)[0]
        if b[at:b.index(0, at)] == sys.argv[3].encode():
            struct.pack_into('<I', b, off, 0xd)
            break
    off += size
else:
    sys.exit(f'{action}: no matching load command in {path}')
open(path, 'wb').write(b)
