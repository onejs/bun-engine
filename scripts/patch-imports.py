import struct,sys
p=sys.argv[1]; b=bytearray(open(p,'rb').read()); n,s=struct.unpack_from('<II',b,16); off=32; ordinal=0; imports=None; existing=None
for i in range(n):
 c,z=struct.unpack_from('<II',b,off)
 if c==0xc:
  ordinal+=1;at=off+struct.unpack_from('<I',b,off+8)[0]
  if b[at:b.index(0,at)].decode()==sys.argv[2]: existing=ordinal
 if c==0x80000034: imports=struct.unpack_from('<II',b,off+8)[0]
 off+=z
if existing is None:
 lib=sys.argv[2].encode()+b'\0'; z=(24+len(lib)+7)&~7
 cmd=struct.pack('<IIIIII',0xc,z,24,0,0,0)+lib
 b[off:off+z]=cmd.ljust(z,b'\0'); struct.pack_into('<II',b,16,n+1,s+z);existing=ordinal+1
v,st,im,sy,count,fmt,sfmt=struct.unpack_from('<7I',b,imports)
assert fmt==1
for i in range(count):
 at=imports+im+4*i; word=struct.unpack_from('<I',b,at)[0]; nameat=imports+sy+(word>>9); name=b[nameat:b.index(0,nameat)].decode()
 if name in sys.argv[3:]:
  struct.pack_into('<I',b,at,(word&~255)|existing); print(name,'=>',existing)
open(p,'wb').write(b)
