import { readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { features } from './strip-features'

const [work, build, llvm] = process.argv.slice(2)
if (!work || !build || !llvm) throw new Error('usage: trim-entry-points.ts <work> <build> <llvm-bin>')
const source = join(work, 'bun-src/scripts/build/trim')
const trim = join(work, 'embed-trim')
const { readMachOGraph } = await import(join(source, 'macho-graph.ts'))
const entries = await import(join(source, 'entry-points.ts'))
const { readBuiltinUses } = await import(join(source, 'builtin-uses.ts'))
const { Demangler } = await import(join(source, 'report.ts'))
const model = features(join(trim, 'features.json'))
const uses = readBuiltinUses(join(build, 'codegen/builtin-uses.json'))
const compiled = join(trim, 'trim-work/compiled')
const reading = readMachOGraph(join(trim, 'libbun.dylib'), join(trim, 'libbun.map'),
  readdirSync(compiled).sort().map(name => join(compiled, name)), join(work, 'embed-macos/exports.txt'))
if (reading.failures.length) throw new Error(JSON.stringify(reading.failures))
const recorded = entries.readEntryPoints(reading, model, uses.namedByEngine)
if (recorded.failures.length) throw new Error(JSON.stringify(recorded.failures))
const demangler = new Demangler(join(llvm, 'llvm-cxxfilt'))
const input = { reading, model, uses, isCode: (output: string) => ['__TEXT,__text', '__TEXT,__jsc_bytecode', '__TEXT,__jsc_wasm'].includes(output),
  demangle: (names: string[]) => demangler.demangle(names) }
const points = entries.mergeEntryPoints(recorded.entryPoints,
  entries.findStaticTableEntryPoints(input), entries.findCFunctionEntryPoints(reading, model).entryPoints,
  entries.findCxxFunctionEntryPoints(input).entryPoints)
const names = new Map(model.features.map((feature) => [feature.index, feature.name]))
const sections = new Map<number, Set<string>>()
const records = []
for (const { entry, entrySection } of points) {
  if (!sections.has(entry)) sections.set(entry, new Set())
  sections.get(entry)!.add(entrySection)
}
for (const { feature, entry, stub } of points) {
  if ((sections.get(entry)?.size ?? 0) < 1 + (reading.graph.aliases.get(entry)?.length ?? 0)) continue
  records.push({ feature: names.get(feature), stub,
    object: basename(reading.graph.object[entry]), symbols: reading.graph.names[entry] })
}
writeFileSync(join(trim, 'entry-points.json'), JSON.stringify(records))
console.log(`trim: wrote ${records.length} exact entry points`)
