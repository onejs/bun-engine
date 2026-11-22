import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { features, stage, markRemoved } from "./strip-features";

const root =
  process.env.BUN_ENGINE_WORK ?? join(homedir(), ".cache/bun-engine");
const arch = process.env.BUN_ENGINE_ARCH ?? "arm64";
if (arch !== "arm64" && arch !== "x86_64")
  throw new Error("expected arm64 or x86_64");
const build = realpathSync(
    join(
      root,
      "bun-src",
      process.env.BUN_ENGINE_BUILD_DIR ??
        (arch === "arm64"
          ? "build/darwin-release"
          : "build/darwin-x64-release"),
    ),
  ),
  out = join(root, "embed-macos");
mkdirSync(out, { recursive: true });
const ninja = readFileSync(join(build, "build.ninja"), "utf8").replaceAll(
  "$\n",
  "",
);
const link = ninja
  .split("\n")
  .find((line) => line.startsWith("build bun-profile |"));
if (!link) throw new Error("missing runtime link");
const inputs = link
  .split(/:\s+link\s+/)[1]
  .split(/\s+\|\|?\s+/)[0]
  .trim()
  .split(/\s+/)
  .map((path) => resolve(build, path));
const lazy = readFileSync(join(build, "bun-profile.lazy.rsp"), "utf8")
  .trim()
  .split(/\s+/)
  .map((path) => (path.startsWith("--") ? path : resolve(build, path)));
writeFileSync(join(out, "inputs.rsp"), inputs.join("\n"));
writeFileSync(join(out, "lazy.rsp"), lazy.join("\n"));
const toolchain = process.env.BUN_TOOLCHAIN_LLVM;
if (!toolchain) throw new Error("set BUN_TOOLCHAIN_LLVM");
const llvm = join(toolchain, "bin"),
  sdk =
    process.env.MACOS_SDK ?? join(homedir(), ".bun/build-cache/MacOSX26.5.sdk");
const exports = [
  "_bun_embed_*",
  "_bun_embed_drop_locks",
  "_bun_embed_grab_locks",
  "_JSValue*",
  "_JSObject*",
  "_JSString*",
  "_JSContextGroup*",
  "_JSContextGet*",
  "_JSGlobalContext*",
  "_JSEvaluateScript",
  "_JSCheckScriptSyntax",
  "_JSGarbageCollect",
  "_JSClass*",
  "_JSPropertyName*",
  "_JSReportExtraMemoryCost",
  "_kJS*",
];
writeFileSync(join(out, "exports.txt"), exports.join("\n") + "\n");
const flags = [
  "-Wl,@" + join(out, "lazy.rsp"),
  "-dynamiclib",
  "--target=" + arch + "-apple-macosx",
  "-mmacosx-version-min=13.0",
  "-mlinker-version=705",
  "-isysroot",
  sdk,
  "--ld-path=" + join(llvm, "ld64.lld"),
  "-Wl,-dead_strip",
  "-Wl,-rename_section,__BUN,__bun,__DATA,__bun",
  "-Wl,-alias,__mh_dylib_header,__mh_execute_header",
  "-Wl,-dead_strip_dylibs",
  "-exported_symbols_list",
  join(out, "exports.txt"),
  "-Wl,-install_name,@rpath/libbun.dylib",
  "-Wl,-rename_segment,__DATA_DIRTY,__DATA",
  "-Wl,-headerpad,0x3478",
  "-Wl,-adhoc_codesign",
  "-lresolv",
  "-framework",
  "CoreFoundation",
];
const icu = ["libicu-foundation.a", "libicui18n.a", "libicuuc.a", "libicudata.a"].map((name) =>
  join(root, "icu-macos", name),
);
const lto = [
  "-flto=thin",
  "-Wl,--lto-O3",
  "-Wl,--lto-CGO3",
  "-Wl,-mllvm,-whole-program-visibility",
  "-fwhole-program-vtables",
  "-fforce-emit-vtables",
  "-Wl,-mllvm,-inline-cold-callsite-threshold=0",
  "-fno-keep-static-consts",
  "-Wl,--icf=safe",
  "-Wl,--thinlto-jobs=" + (process.env.BUN_ENGINE_JOBS ?? "4"),
];
const dylib = join(out, "libbun.dylib");
function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: "inherit" });
}
const args = process.argv.slice(2);
if (args.length === 0) {
  run(join(llvm, "clang++"), [
    "@" + join(out, "inputs.rsp"),
    ...flags,
    ...lto,
    "-Wl,-cache_path_lto," + join(out, "lto-cache"),
    ...icu,
    "-o",
    dylib,
  ]);
} else {
  if (args.length !== 2 || args[0] !== "--remove")
    throw new Error("usage: relink-macos-embed.ts [--remove <features file>]");
  const removed = new Set(
    readFileSync(args[1], "utf8")
      .split("\n")
      .map((line) => line.split("#")[0].trim())
      .filter(Boolean),
  );
  const trim = join(root, "embed-trim");
  rmSync(join(trim, "strip"), { recursive: true, force: true });
  mkdirSync(trim, { recursive: true });
  writeFileSync(
    join(trim, "features.json"),
    JSON.stringify(features(join(build, "codegen/removable-features.json"))),
  );
  run("bun", [
    join(root, "bun-src/scripts/build/trim/link.ts"),
    join(trim, "trim-work"),
    join(trim, "features.json"),
    join(build, "codegen/builtin-uses.json"),
    "--demangler=" + join(llvm, "llvm-cxxfilt"),
    "--",
    join(llvm, "clang++"),
    "@" + join(out, "inputs.rsp"),
    ...flags,
    ...lto,
    "-Wl,-cache_path_lto," + join(trim, "lto-cache"),
    ...icu,
    "-Wl,-map," + join(trim, "libbun.map"),
    "-o",
    join(trim, "libbun.dylib"),
  ]);
  run("bun", [join(import.meta.dirname, "trim-entry-points.ts"), root, build, llvm]);
  const objects = stage(trim, llvm, removed, join(trim, "strip"), arch);
  const native = (path: string) => {
    if (path.startsWith("--")) return true;
    const fd = openSync(path, "r"),
      magic = Buffer.alloc(4);
    try {
      readSync(fd, magic, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
    return (
      !magic.equals(Buffer.from([0x42, 0x43, 0xc0, 0xde])) &&
      !magic.equals(Buffer.from([0xde, 0xc0, 0x17, 0x0b]))
    );
  };
  writeFileSync(
    join(trim, "native.rsp"),
    [...objects, ...inputs.filter(native), ...icu].join("\n") + "\n",
  );
  writeFileSync(
    join(trim, "native-lazy.rsp"),
    lazy.filter(native).join("\n") + "\n",
  );
  run(join(llvm, "clang++"), [
    "@" + join(trim, "native.rsp"),
    "-Wl,@" + join(trim, "native-lazy.rsp"),
    ...flags.slice(1),
    "-Wl,--icf=safe",
    "-o",
    dylib,
  ]);
  markRemoved(dylib, join(trim, "features.json"), removed, llvm);
}
run(join(llvm, "llvm-strip"), [
  "-S",
  "-o",
  join(out, "libbun-stripped.dylib"),
  dylib,
]);
