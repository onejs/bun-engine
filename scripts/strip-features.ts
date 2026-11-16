import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

const entry = /^(\S+) (\S+) (\d+) (.*) \((\S+), (\d+) bytes\)$/;
const trap =
  ".text\n.globl _bun_removed_feature\n.p2align 14\n_bun_removed_feature:\n.rept 4096\nbrk #0xbad\n.endr\n";
class MachO {
  sections: { flags: number; offset: number; count: number }[] = [];
  symtab = 0;
  dysymtab = 0;
  constructor(public bytes: Buffer) {
    if (bytes.readUInt32LE(0) !== 0xfeedfacf)
      throw new Error("expected Mach-O object");
    for (let at = 32, count = bytes.readUInt32LE(16); count; count--) {
      const command = bytes.readUInt32LE(at),
        size = bytes.readUInt32LE(at + 4);
      if (command === 0x19)
        for (let index = 0; index < bytes.readUInt32LE(at + 64); index++) {
          const section = at + 72 + index * 80;
          this.sections.push({
            flags: bytes.readUInt32LE(section + 64),
            offset: bytes.readUInt32LE(section + 56),
            count: bytes.readUInt32LE(section + 60),
          });
        }
      else if (command === 2) this.symtab = at;
      else if (command === 0xb) this.dysymtab = at;
      at += size;
    }
    if (!this.symtab || !this.dysymtab)
      throw new Error("object has no symbol tables");
  }
  symbols() {
    const bytes = this.bytes,
      offset = bytes.readUInt32LE(this.symtab + 8),
      count = bytes.readUInt32LE(this.symtab + 12),
      strings = bytes.readUInt32LE(this.symtab + 16);
    return Array.from({ length: count }, (_, index) => {
      const at = offset + index * 16,
        start = strings + bytes.readUInt32LE(at);
      return {
        index,
        name: bytes.toString("latin1", start, bytes.indexOf(0, start)),
        type: bytes[at + 4],
      };
    });
  }
  addUndefined(name: string) {
    const bytes = this.bytes,
      symoff = bytes.readUInt32LE(this.symtab + 8),
      count = bytes.readUInt32LE(this.symtab + 12),
      stroff = bytes.readUInt32LE(this.symtab + 16),
      strsize = bytes.readUInt32LE(this.symtab + 20);
    const symbol = Buffer.alloc(16);
    symbol.writeUInt32LE(strsize);
    symbol[4] = 1;
    const symbols = Buffer.concat([
      bytes.subarray(symoff, symoff + 16 * count),
      symbol,
    ]);
    const strings = Buffer.concat([
      bytes.subarray(stroff, stroff + strsize),
      Buffer.from(name + "\0"),
    ]);
    const next = Math.ceil(bytes.length / 8) * 8;
    this.bytes = Buffer.concat([
      bytes,
      Buffer.alloc(next - bytes.length),
      symbols,
      strings,
    ]);
    this.bytes.writeUInt32LE(next, this.symtab + 8);
    this.bytes.writeUInt32LE(count + 1, this.symtab + 12);
    this.bytes.writeUInt32LE(next + symbols.length, this.symtab + 16);
    this.bytes.writeUInt32LE(strings.length, this.symtab + 20);
    this.bytes.writeUInt32LE(
      bytes.readUInt32LE(this.dysymtab + 28) + 1,
      this.dysymtab + 28,
    );
    return count;
  }
  retarget(targets: Set<number>, to: number) {
    let changed = 0;
    for (const section of this.sections) {
      if (section.flags & 0x02000000) continue;
      for (let index = 0; index < section.count; index++) {
        const at = section.offset + 8 * index + 4,
          word = this.bytes.readUInt32LE(at);
        if (
          (word >>> 27) & 1 &&
          word >>> 28 !== 10 &&
          targets.has(word & 0xffffff)
        ) {
          this.bytes.writeUInt32LE(((word & 0xff000000) | to) >>> 0, at);
          changed++;
        }
      }
    }
    return changed;
  }
}
function entryPoints(report: string, removed: Set<string>) {
  const groups = new Map<
    string,
    { object: string; name: string; owners: Set<string> }
  >();
  for (const line of readFileSync(
    join(report, "entry-points.txt"),
    "utf8",
  ).split("\n")) {
    const match = entry.exec(line.split(" <- ")[0]);
    if (!match) continue;
    const key = match[5] + "\0" + match[4];
    const group = groups.get(key) ?? {
      object: match[5],
      name: match[4],
      owners: new Set<string>(),
    };
    group.owners.add(match[1]);
    groups.set(key, group);
  }
  const entries = new Map<string, Set<string>>();
  for (const group of groups.values()) {
    // demangled names can identify several symbols; every owner must be removed.
    if (![...group.owners].every((owner) => removed.has(owner))) continue;
    const names = entries.get(group.object) ?? new Set<string>();
    names.add(group.name);
    entries.set(group.object, names);
  }
  return entries;
}
function demangle(llvm: string, names: string[]) {
  return execFileSync(join(llvm, "llvm-cxxfilt"), ["-n"], {
    input: names
      .map((name) => (name.startsWith("_") ? name.slice(1) : name))
      .join("\n"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\n");
}
export function stage(
  trim: string,
  llvm: string,
  removed: Set<string>,
  output: string,
) {
  const compiled = join(trim, "trim-work/compiled"),
    objects = new Map<string, MachO>();
  const folder = join(output, "objs");
  mkdirSync(folder, { recursive: true });
  for (const name of readdirSync(compiled).filter((name) =>
    name.endsWith(".o"),
  ))
    objects.set(name, new MachO(readFileSync(join(compiled, name))));
  const entries = entryPoints(join(trim, "libbun.dylib.trim"), removed);
  const global = new Set<string>(),
    local = new Map<string, Set<number>>();
  let missing = 0,
    edited = 0;
  for (const [name, wanted] of entries) {
    const object = objects.get(name);
    if (!object) {
      missing += wanted.size;
      continue;
    }
    const symbols = object.symbols(),
      display = demangle(
        llvm,
        symbols.map((symbol) => symbol.name),
      ),
      found = new Set<string>();
    for (const [index, symbol] of symbols.entries()) {
      if ((symbol.type & 0x0e) !== 0x0e || !wanted.has(display[index]))
        continue;
      found.add(display[index]);
      if (symbol.type & 1) global.add(symbol.name);
      else {
        const indices = local.get(name) ?? new Set<number>();
        indices.add(symbol.index);
        local.set(name, indices);
      }
    }
    missing += [...wanted].filter((name) => !found.has(name)).length;
  }
  for (const [name, object] of objects) {
    const targets = new Set(local.get(name));
    for (const symbol of object.symbols())
      if (global.has(symbol.name)) targets.add(symbol.index);
    if (
      targets.size &&
      object.retarget(targets, object.addUndefined("_bun_removed_feature"))
    ) {
      writeFileSync(join(folder, name), object.bytes);
      edited++;
    } else symlinkSync(resolve(compiled, name), join(folder, name));
  }
  writeFileSync(join(output, "trap.s"), trap);
  execFileSync(join(llvm, "clang"), [
    "--target=arm64-apple-macosx",
    "-c",
    join(output, "trap.s"),
    "-o",
    join(folder, "zz-trap.o"),
  ]);
  console.log(
    `strip: ${entries.size} object groups, ${missing} names not found, ${edited} objects edited`,
  );
  return readdirSync(folder)
    .sort()
    .map((name) => join(folder, name));
}
export function features(path: string) {
  const document: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !document ||
    typeof document !== "object" ||
    !("features" in document) ||
    !Array.isArray(document.features)
  )
    throw new Error("invalid feature table");
  const list = document.features.map((feature: unknown) => {
    if (
      !feature ||
      typeof feature !== "object" ||
      !("name" in feature) ||
      typeof feature.name !== "string" ||
      !("index" in feature) ||
      !Number.isInteger(feature.index)
    )
      throw new Error("invalid feature record");
    if (typeof feature.index !== "number" || feature.index < 0)
      throw new Error("invalid feature index");
    return {
      ...feature,
      name: feature.name,
      index: feature.index,
      minimumBytes: 0,
    };
  });
  return { ...document, features: list };
}
export function markRemoved(
  dylib: string,
  table: string,
  removed: Set<string>,
  llvm: string,
) {
  const index = new Map(
    features(table).features.map((feature) => [feature.name, feature.index]),
  );
  const nm = execFileSync(join(llvm, "llvm-nm"), ["--defined-only", dylib], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = nm
    .split("\n")
    .find((line) => line.endsWith(" _Bun__removableFeatureState"));
  if (!line) throw new Error("missing feature state");
  const address = Number.parseInt(line.split(/\s+/)[0], 16),
    bytes = readFileSync(dylib);
  if (!bytes.subarray(address, address + 8).equals(Buffer.from("BUNFEAT\0")))
    throw new Error("feature state is not at its symbol");
  for (const name of removed) {
    const offset = index.get(name);
    if (offset === undefined) throw new Error("unknown feature " + name);
    bytes[address + 24 + offset] = 1;
  }
  writeFileSync(dylib, bytes);
}
