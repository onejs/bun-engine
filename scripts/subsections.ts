import { readFileSync, writeFileSync } from "node:fs";
for (const path of process.argv.slice(2)) {
  const bytes = readFileSync(path);
  if (
    bytes.readUInt32LE(0) !== 0xfeedfacf ||
    bytes.readUInt32LE(12) !== 1 ||
    bytes.readUInt32LE(24) & 0x2000
  )
    continue;
  let symbols = 0,
    count = 0,
    strings = 0;
  for (let at = 32, commands = bytes.readUInt32LE(16); commands; commands--) {
    if (bytes.readUInt32LE(at) === 2) {
      symbols = bytes.readUInt32LE(at + 8);
      count = bytes.readUInt32LE(at + 12);
      strings = bytes.readUInt32LE(at + 16);
    }
    at += bytes.readUInt32LE(at + 4);
  }
  const entries: { section: number; value: bigint; offset: number }[] = [];
  for (let index = 0; index < count; index++) {
    const at = symbols + 16 * index,
      start = strings + bytes.readUInt32LE(at);
    if (
      (bytes[at + 4] & 0x0e) !== 0x0e ||
      bytes[start] === 0x6c ||
      bytes[start] === 0x4c
    )
      continue;
    entries.push({
      section: bytes[at + 5],
      value: bytes.readBigUInt64LE(at + 8),
      offset: at,
    });
  }
  entries.sort(
    (a, b) =>
      a.section - b.section ||
      (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  );
  const first = new Set<number>();
  for (const entry of entries) {
    if (first.has(entry.section))
      bytes.writeUInt16LE(
        bytes.readUInt16LE(entry.offset + 6) | 0x200,
        entry.offset + 6,
      );
    else first.add(entry.section);
  }
  bytes.writeUInt32LE(bytes.readUInt32LE(24) | 0x2000, 24);
  writeFileSync(path, bytes);
}
