# marks a data-only object as splittable at its symbols: sets MH_SUBSECTIONS_VIA_SYMBOLS and makes every
# symbol after the first in its section an alt entry, so each section stays one atom for dead stripping
import struct, sys
N_SECT, N_ALT_ENTRY = 0x0e, 0x0200
for path in sys.argv[1:]:
    b = bytearray(open(path, 'rb').read())
    if b[:4] != b'\xcf\xfa\xed\xfe' or struct.unpack_from('<I', b, 12)[0] != 1 or struct.unpack_from('<I', b, 24)[0] & 0x2000:
        continue
    off = 32
    for _ in range(struct.unpack_from('<I', b, 16)[0]):
        cmd, size = struct.unpack_from('<II', b, off)
        if cmd == 0x2: symoff, nsyms, stroff = struct.unpack_from('<III', b, off + 8)
        off += size
    first = {}
    syms = []
    for i in range(nsyms):
        at = symoff + 16 * i
        strx, ntype, sect, desc, value = struct.unpack_from('<IBBHQ', b, at)
        name = b[stroff + strx:b.index(0, stroff + strx)]
        # assembler temporaries (l, L) are never atom boundaries
        if ntype & 0x0e == N_SECT and name[:1] not in (b'l', b'L'): syms.append((sect, value, at))
    for sect, value, at in sorted(syms):
        if sect in first:
            struct.pack_into('<H', b, at + 6, struct.unpack_from('<H', b, at + 6)[0] | N_ALT_ENTRY)
        else: first[sect] = at
    struct.pack_into('<I', b, 24, struct.unpack_from('<I', b, 24)[0] | 0x2000)
    open(path, 'wb').write(b)
