# ld64.lld writes no LC_ENCRYPTION_INFO_64, which App Store validation requires of
# an iOS binary: add the one Apple's linker writes, covering __TEXT after its first page
import struct, sys
LC_SEGMENT_64, LC_ENCRYPTION_INFO_64 = 0x19, 0x2c
path = sys.argv[1]
b = bytearray(open(path, 'rb').read())
count, size = struct.unpack_from('<II', b, 16)
offset, text, first_section = 32, None, None
for _ in range(count):
    command, command_size = struct.unpack_from('<II', b, offset)
    if command == LC_ENCRYPTION_INFO_64:
        sys.exit(f'{path} already has LC_ENCRYPTION_INFO_64')
    if command == LC_SEGMENT_64:
        if b[offset + 8:offset + 14] == b'__TEXT':
            text = struct.unpack_from('<Q', b, offset + 48)[0]
        for section in range(struct.unpack_from('<I', b, offset + 64)[0]):
            at = struct.unpack_from('<I', b, offset + 72 + 80 * section + 48)[0]
            if at and (first_section is None or at < first_section):
                first_section = at
    offset += command_size
if 32 + size + 24 > first_section:
    sys.exit(f'{path} has no room for another load command')
page = 16384
if first_section < page:
    sys.exit(f'{path} starts its code at {first_section:#x}, before the encrypted page at {page:#x}: link it with -headerpad so its first section starts there')
b[offset:offset + 24] = struct.pack('<IIIIII', LC_ENCRYPTION_INFO_64, 24, page, text - page, 0, 0)
struct.pack_into('<II', b, 16, count + 1, size + 24)
open(path, 'wb').write(b)
