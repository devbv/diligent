// @summary Build a fresh standalone diligent-web-server binary for local overdare-ai-agent diagnostics.

import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const OVERDARE_SIDECAR = resolve(ROOT, "apps/overdare-ai-agent/sidecar");
const VALIDATOR_PLUGIN = resolve(ROOT, "apps/overdare-ai-agent/plugins/plugin-validator");
const OUT_DIR = resolve(ROOT, "apps/overdare-ai-agent/.diligent/diagnostics");

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
    ["bun", "build", "--compile", `--target=${bunTarget}`, serverEntry, "--outfile", outPath],
    {
      cwd: ROOT,
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Fresh sidecar build failed for ${platformKey}`);
  }

  const validatorAssetsDir = resolve(OUT_DIR, "validator");
  await rm(validatorAssetsDir, { recursive: true, force: true });
  await mkdir(validatorAssetsDir, { recursive: true });
  await cp(resolve(VALIDATOR_PLUGIN, luauLspName(platformKey)), resolve(validatorAssetsDir, luauLspName(platformKey)));
  await cp(resolve(VALIDATOR_PLUGIN, "overdare-types.d.lua"), resolve(validatorAssetsDir, "overdare-types.d.lua"));

  console.log(outPath);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
