import { readFileSync, writeFileSync } from "node:fs";
import { features } from "./strip-features";
const [source, table, removedFile, output, target] = process.argv.slice(2);
const platform = Number(target);
if (
  !source ||
  !table ||
  !removedFile ||
  !output ||
  ![1, 2, 7].includes(platform)
)
  throw new Error(
    "usage: finish-object.ts <engine.o> <features.json> <removed-features.txt> <out.o> <platform 1|2|7>",
  );
const bytes = readFileSync(source);
if (bytes.readUInt32LE(0) !== 0xfeedfacf)
  throw new Error("expected 64-bit Mach-O");
const sections: { address: number; size: number; offset: number }[] = [];
let symbols = 0,
  strings = 0,
  count = 0;
for (let at = 32, commands = bytes.readUInt32LE(16); commands; commands--) {
  const command = bytes.readUInt32LE(at),
    size = bytes.readUInt32LE(at + 4);
  if (size < 8 || at + size > bytes.length)
    throw new Error("invalid Mach-O command");
  if (command === 0x19)
    for (let index = 0; index < bytes.readUInt32LE(at + 64); index++) {
      const section = at + 72 + 80 * index;
      sections.push({
        address: Number(bytes.readBigUInt64LE(section + 32)),
        size: Number(bytes.readBigUInt64LE(section + 40)),
        offset: bytes.readUInt32LE(section + 48),
      });
    }
  else if (command === 2) {
    symbols = bytes.readUInt32LE(at + 8);
    count = bytes.readUInt32LE(at + 12);
    strings = bytes.readUInt32LE(at + 16);
  } else if (command === 0x32) {
    bytes.writeUInt32LE(platform, at + 8);
    bytes.writeUInt32LE((platform === 1 ? 13 : 17) << 16, at + 12);
    bytes.writeUInt32LE(
      platform === 1 ? (26 << 16) | (5 << 8) : (27 << 16) | (1 << 8),
      at + 16,
    );
  }
  at += size;
}
let state = -1;
for (let index = 0; index < count; index++) {
  const at = symbols + 16 * index,
    start = strings + bytes.readUInt32LE(at);
  if (
    bytes.toString("utf8", start, bytes.indexOf(0, start)) !==
    "_Bun__removableFeatureState"
  )
    continue;
  const address = Number(bytes.readBigUInt64LE(at + 8));
  const section = sections.find(
    (section) =>
      section.address <= address && address < section.address + section.size,
  );
  if (section) state = section.offset + address - section.address;
  break;
}
if (state < 0 || bytes.toString("latin1", state, state + 8) !== "BUNFEAT\0")
  throw new Error("feature state is not at its symbol");
const indices = new Map(
  features(table).features.map((feature) => [feature.name, feature.index]),
);
const removed = readFileSync(removedFile, "utf8")
  .split("\n")
  .map((line) => line.split("#")[0].trim())
  .filter(Boolean);
for (const name of removed) {
  const index = indices.get(name);
  if (index === undefined) throw new Error("unknown feature: " + name);
  bytes[state + 24 + index] = 1;
}
writeFileSync(output, bytes);
console.log(output + ": " + removed.length + " features marked removed");
