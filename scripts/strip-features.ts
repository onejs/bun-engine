import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

const armStubs = ".text\n.subsections_via_symbols\n.globl _bun_removed_Abort\n_bun_removed_Abort:\nbrk #0xbad\n.globl _bun_removed_ReturnDefault\n_bun_removed_ReturnDefault:\nmov x0, #0\nret\n.globl _bun_removed_ReturnUndefined\n_bun_removed_ReturnUndefined:\nmov x0, #10\nret\n";
const x64Stubs = ".text\n.subsections_via_symbols\n.globl _bun_removed_Abort\n_bun_removed_Abort:\nud2\n.globl _bun_removed_ReturnDefault\n_bun_removed_ReturnDefault:\nxor %eax, %eax\nret\n.globl _bun_removed_ReturnUndefined\n_bun_removed_ReturnUndefined:\nmov $10, %eax\nret\n";
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
    if (this.symtab && !this.dysymtab)
      throw new Error("object has no symbol tables");
  }
  symbols() {
    if (!this.symtab) return [];
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
          (this.bytes.readUInt32LE(4) !== 0x100000c || word >>> 28 !== 10) &&
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

type Stub = "Abort" | "ReturnDefault" | "ReturnUndefined";
type EntryPoint = { object: string; feature: string; symbols: string[]; stub: Stub };

function entryPoints(path: string): EntryPoint[] {
  const records: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(records)) throw new Error("invalid entry-point table");
  return records.map((record: unknown) => {
    if (record === null || typeof record !== "object" ||
      !("object" in record) || typeof record.object !== "string" ||
      !("feature" in record) || typeof record.feature !== "string" ||
      !("symbols" in record) || !Array.isArray(record.symbols) ||
      !record.symbols.every((name: unknown): name is string => typeof name === "string") ||
      !("stub" in record))
      throw new Error("invalid entry point");
    return {
      object: record.object,
      feature: record.feature,
      symbols: record.symbols,
      stub: record.stub === "ReturnDefault" || record.stub === "ReturnUndefined"
        ? record.stub
        : "Abort",
    };
  });
}
export function stage(
  trim: string,
  llvm: string,
  removed: Set<string>,
  output: string,
  arch: "arm64" | "x86_64" = "arm64",
) {
  const compiled = join(trim, "trim-work/compiled"),
    objects = new Map<string, MachO>();
  const folder = join(output, "objs");
  mkdirSync(folder, { recursive: true });
  for (const name of readdirSync(compiled).filter((name) =>
    name.endsWith(".o"),
  ))
    objects.set(name, new MachO(readFileSync(join(compiled, name))));

  const entries = entryPoints(join(trim, "entry-points.json"));
  const known = new Set(features(join(trim, "features.json")).features.map(({ name }) => name));
  for (const name of removed) {
    if (!known.has(name)) throw new Error("unknown feature " + name);
  }
  const kept = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (removed.has(entry.feature)) continue;
    const symbols = kept.get(entry.object) ?? new Set<string>();
    for (const name of entry.symbols) symbols.add(name);
    kept.set(entry.object, symbols);
  }
  const global = new Map<string, Stub>();
  const local = new Map<string, Map<number, Stub>>();
  for (const entry of entries) {
    if (!removed.has(entry.feature)) continue;
    const object = objects.get(entry.object);
    if (!object) throw new Error("missing entry-point object " + entry.object);
    const wanted = new Set(entry.symbols.filter((symbol) => !kept.get(entry.object)?.has(symbol)));
    const found = new Set<string>();
    const targets = local.get(entry.object) ?? new Map<number, Stub>();
    local.set(entry.object, targets);
    for (const symbol of object.symbols()) {
      if ((symbol.type & 0x0e) !== 0x0e || !wanted.has(symbol.name)) continue;
      found.add(symbol.name);
      if (symbol.type & 1) {
        if ((global.get(symbol.name) ?? "Abort") === "Abort") global.set(symbol.name, entry.stub);
      } else if ((targets.get(symbol.index) ?? "Abort") === "Abort") {
        targets.set(symbol.index, entry.stub);
      }
    }
    const missing = [...wanted].filter((symbol) => !found.has(symbol));
    if (missing.length) throw new Error(entry.object + ": missing entry points " + missing.join(", "));
  }
  let edited = 0;
  for (const [name, object] of objects) {
    const targets = new Map(local.get(name));
    for (const symbol of object.symbols()) {
      const stub = global.get(symbol.name);
      if (stub) targets.set(symbol.index, stub);
    }
    let changed = 0;
    for (const stub of new Set(targets.values())) {
      const selected = new Set([...targets].filter(([, kind]) => kind === stub).map(([index]) => index));
      changed += object.retarget(selected, object.addUndefined("_bun_removed_" + stub));
    }
    if (changed) {
      writeFileSync(join(folder, name), object.bytes);
      edited++;
    } else symlinkSync(resolve(compiled, name), join(folder, name));
  }
  writeFileSync(join(output, "trap.s"), arch === "arm64" ? armStubs : x64Stubs);
  execFileSync(join(llvm, "clang"), [
    "--target=" + arch + "-apple-macosx",
    "-c",
    join(output, "trap.s"),
    "-o",
    join(folder, "zz-trap.o"),
  ]);
  console.log(
    `strip: ${entries.length} exact entry points, ${edited} objects edited`,
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
