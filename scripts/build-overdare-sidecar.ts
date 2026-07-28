// @summary Build a fresh standalone diligent-web-server binary for local overdare-ai-agent diagnostics.

import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const OVERDARE_SIDECAR = resolve(ROOT, "apps/overdare-ai-agent/sidecar");
const SIDECAR_ASSETS = resolve(OVERDARE_SIDECAR, "assets");
const OUT_DIR = resolve(ROOT, "apps/overdare-ai-agent/.diligent/diagnostics");

const VENDORED_LUAU_VERSION = "0.723";
const VENDORED_LUAU_DIR = resolve(OVERDARE_SIDECAR, "vendor", "luau", VENDORED_LUAU_VERSION);

// Maps a build platform key to the vendored procedural Luau interpreter subdir.
// Only the officially supported targets ship a bundled interpreter.
const LUAU_VENDOR_SUBDIR_BY_PLATFORM = new Map<string, string>([
  ["darwin-arm64", "darwin"],
  ["windows-x64", "win32"],
  ["linux-x64", "linux"],
]);

function proceduralLuauName(platformKey: string): string {
  return platformKey === "windows-x64" ? "luau.exe" : "luau";
}

const TARGET_BY_PLATFORM = new Map<string, string>([
  ["darwin-arm64", "bun-darwin-arm64"],
  ["darwin-x64", "bun-darwin-x64"],
  ["linux-x64", "bun-linux-x64"],
  ["windows-x64", "bun-windows-x64"],
]);

function executableExtension(platformKey: string): string {
  return platformKey === "windows-x64" ? ".exe" : "";
}

function luauLspName(platformKey: string): string {
  return platformKey === "windows-x64" ? "luau-lsp.exe" : "luau-lsp";
}

function currentPlatformKey(): string {
  if (process.platform === "win32") {
    return `windows-${process.arch}`;
  }
  return `${process.platform}-${process.arch}`;
}

function parseCliOptions(argv: string[]): { platformKey: string; outfile?: string } {
  const { values } = parseArgs({
    args: argv,
    options: {
      platform: { type: "string" },
      outfile: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    platformKey: values.platform?.trim() || currentPlatformKey(),
    outfile: values.outfile?.trim() || undefined,
  };
}

async function run(): Promise<void> {
  const { platformKey, outfile } = parseCliOptions(process.argv.slice(2));
  const bunTarget = TARGET_BY_PLATFORM.get(platformKey);
  if (!bunTarget) {
    throw new Error(`Unsupported platform for sidecar diagnostics build: ${platformKey}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = outfile ?? resolve(OUT_DIR, `diligent-web-server${executableExtension(platformKey)}`);
  const serverEntry = resolve(OVERDARE_SIDECAR, "src/server.ts");

  const result = Bun.spawnSync(
    // --sourcemap embeds the map so runtime stack traces (including Sentry events)
    // point at original TypeScript sources instead of bundled offsets.
    ["bun", "build", "--compile", "--sourcemap", `--target=${bunTarget}`, serverEntry, "--outfile", outPath],
    {
      cwd: ROOT,
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Fresh sidecar build failed for ${platformKey}`);
  }

  const assetsDir = resolve(OUT_DIR, "assets");
  await rm(assetsDir, { recursive: true, force: true });
  await mkdir(resolve(assetsDir, "bin"), { recursive: true });
  await mkdir(resolve(assetsDir, "lua"), { recursive: true });
  await cp(
    resolve(SIDECAR_ASSETS, "bin", luauLspName(platformKey)),
    resolve(assetsDir, "bin", luauLspName(platformKey)),
  );
  await cp(resolve(SIDECAR_ASSETS, "lua", "overdare-types.d.lua"), resolve(assetsDir, "lua", "overdare-types.d.lua"));

  // Stage the procedural runner + its Luau dependencies on real disk under
  // assets/lua/procedural. In a compiled binary `import.meta.url` resolves into
  // Bun's embedded virtual filesystem, which the external luau subprocess cannot
  // read, so runtime.ts (resolveLuauRunnerDir) looks here beside the executable.
  await cp(resolve(OVERDARE_SIDECAR, "src", "procedural", "luau"), resolve(assetsDir, "lua", "procedural"), {
    recursive: true,
  });

  // Bundle the procedural runtime's Luau interpreter beside the executable so
  // studiorpc_procedural_* tools work in the packaged sidecar (resolved via
  // assets/bin by src/procedural/runtime.ts). Preserves the executable bit.
  const luauSubdir = LUAU_VENDOR_SUBDIR_BY_PLATFORM.get(platformKey);
  if (luauSubdir) {
    const luauName = proceduralLuauName(platformKey);
    await cp(resolve(VENDORED_LUAU_DIR, luauSubdir, luauName), resolve(assetsDir, "bin", luauName));
  } else {
    console.warn(
      `No vendored procedural Luau interpreter for ${platformKey}; ` +
        "procedural tools will fall back to OVDR_LUAU_BIN/LUAU_BIN or a `luau` on PATH.",
    );
  }

  console.log(outPath);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
