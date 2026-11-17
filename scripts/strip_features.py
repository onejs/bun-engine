# leaves features out of the runtime without cutting its image. bun's trim cuts split __TEXT into several
# executable segments, which App Store validation rejects (ITMS 90999), so instead every reference to an entry
# point of a removed feature is pointed at a trap, the objects are linked natively and -dead_strip drops what
# only those entry points reached. the feature state then marks them removed, as bun compile does.
import collections, json, os, struct, subprocess

TRAP = """.text
.subsections_via_symbols
.globl _bun_removed_Abort
.p2align 2
_bun_removed_Abort:
brk #0xbad
.globl _bun_removed_ReturnDefault
.p2align 2
_bun_removed_ReturnDefault:
mov x0, #0
ret
.globl _bun_removed_ReturnUndefined
.p2align 2
_bun_removed_ReturnUndefined:
mov x0, #10
ret
"""


class MachO:
    def __init__(self, data):
        self.b = b = bytearray(data)
        assert struct.unpack_from("<I", b, 0)[0] == 0xfeedfacf, "not a 64-bit mach-o object"
        ncmds = struct.unpack_from("<I", b, 16)[0]
        self.sections = []
        off = 32
        for _ in range(ncmds):
            cmd, size = struct.unpack_from("<II", b, off)
            if cmd == 0x19:
                for s in range(struct.unpack_from("<I", b, off + 64)[0]):
                    at = off + 72 + 80 * s
                    reloff, nreloc, flags = struct.unpack_from("<III", b, at + 56)
                    self.sections.append((flags, reloff, nreloc))
            elif cmd == 0x2:
                self.symtab = off
            elif cmd == 0xb:
                self.dysymtab = off
            off += size
        self.symoff, self.nsyms, self.stroff, self.strsize = struct.unpack_from("<IIII", b, self.symtab + 8)

    def symbols(self):
        for i in range(self.nsyms):
            strx, ntype = struct.unpack_from("<IB", self.b, self.symoff + 16 * i)
            start = self.stroff + strx
            yield i, self.b[start:self.b.index(0, start)].decode("latin1"), ntype

    def add_undefined(self, name):
        b = self.b
        syms = bytes(b[self.symoff:self.symoff + 16 * self.nsyms])
        strs = bytes(b[self.stroff:self.stroff + self.strsize])
        syms += struct.pack("<IBBHQ", len(strs), 0x01, 0, 0, 0)
        strs += name.encode() + b"\0"
        while len(b) % 8: b.append(0)
        symoff = len(b); b += syms
        stroff = len(b); b += strs
        while len(b) % 8: b.append(0)
        struct.pack_into("<IIII", b, self.symtab + 8, symoff, self.nsyms + 1, stroff, len(strs))
        nundef = self.dysymtab + 28
        struct.pack_into("<I", b, nundef, struct.unpack_from("<I", b, nundef)[0] + 1)
        self.symoff, self.nsyms, self.stroff, self.strsize = symoff, self.nsyms + 1, stroff, len(strs)
        return self.nsyms - 1

    def retarget(self, targets, to):
        count = 0
        for flags, reloff, nreloc in self.sections:
            if flags & 0x02000000: continue  # debug sections keep their references
            for r in range(nreloc):
                at = reloff + 8 * r + 4
                word = struct.unpack_from("<I", self.b, at)[0]
                # extern relocations other than ARM64_RELOC_ADDEND name a symbol in their low 24 bits
                if (word >> 27) & 1 and word >> 28 != 10 and word & 0xffffff in targets:
                    struct.pack_into("<I", self.b, at, (word & ~0xffffff) | to)
                    count += 1
        return count


def stage(trim, llvm, removed, out):
    """writes <out>/objs: the trim link's compiled objects with references to removed entry points retargeted"""
    compiled = trim / "trim-work/compiled"
    objs = out / "objs"
    objs.mkdir(parents=True)
    objects = {p.name: MachO(p.read_bytes()) for p in compiled.glob("*.o")}
    entries = json.loads((trim / "entry-points.json").read_text())
    known = {f["name"] for f in json.loads((trim / "features.json").read_text())["features"]}
    if removed - known: raise ValueError(f"unknown removed features: {sorted(removed - known)}")
    global_entries, local_entries = {}, collections.defaultdict(dict)
    kept = collections.defaultdict(set)
    for entry in entries:
        if entry["feature"] not in removed: kept[entry["object"]].update(entry["symbols"])
    missing = set()
    for entry in entries:
        if entry["feature"] not in removed: continue
        name = entry["object"]
        obj = objects.get(name)
        if obj is None:
            missing.add(name); continue
        wanted = set(entry["symbols"]) - kept[name]
        stub = entry["stub"] if entry["stub"] in ("ReturnDefault", "ReturnUndefined") else "Abort"
        for i, mangled, ntype in obj.symbols():
            if (ntype & 0x0e) != 0x0e or mangled not in wanted: continue
            targets = global_entries if ntype & 0x01 else local_entries[name]
            key = mangled if ntype & 0x01 else i
            # a recoverable guard may share its entry point with an aborting guard
            if targets.get(key, "Abort") == "Abort": targets[key] = stub
    if missing: raise ValueError(f"entry point objects missing: {sorted(missing)}")
    edited = 0
    for name, obj in objects.items():
        targets = dict(local_entries.get(name, {}))
        targets.update({i: global_entries[mangled] for i, mangled, _ in obj.symbols() if mangled in global_entries})
        count = 0
        for stub in set(targets.values()):
            selected = {i for i, kind in targets.items() if kind == stub}
            count += obj.retarget(selected, obj.add_undefined("_bun_removed_" + stub))
        if count:
            (objs / name).write_bytes(obj.b); edited += 1
        else:
            os.symlink((compiled / name).resolve(), objs / name)
    (out / "trap.s").write_text(TRAP)
    subprocess.run([str(llvm / "clang"), "--target=arm64-apple-macosx", "-c", str(out / "trap.s"), "-o", str(objs / "zz-trap.o")], check=True)
    print(f"strip: {len(global_entries) + sum(map(len, local_entries.values()))} exact entry points, {edited} objects edited")
    return sorted(str(p) for p in objs.iterdir())


def mark_removed(dylib, features_json, removed, llvm):
    """sets each removed feature's byte in _Bun__removableFeatureState, so its guards take the removed path"""
    index = {f["name"]: f["index"] for f in json.load(open(features_json))["features"]}
    nm = subprocess.run([str(llvm / "llvm-nm"), "--defined-only", str(dylib)], capture_output=True, text=True, check=True).stdout
    addr = next(int(l.split()[0], 16) for l in nm.splitlines() if l.endswith(" _Bun__removableFeatureState"))
    b = bytearray(dylib.read_bytes())
    # __TEXT maps file offset 0 at address 0 in this dylib, so the address is the file offset
    assert b[addr:addr + 8] == b"BUNFEAT\0", "feature state is not at its symbol"
    for name in removed:
        b[addr + 24 + index[name]] = 1
    dylib.write_bytes(b)
