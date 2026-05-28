// @summary Build a fresh standalone diligent-web-server binary for local overdare-ai-agent diagnostics.

import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

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

function currentPlatformKey(): string {
  if (process.platform === "win32") {
    return `windows-${process.arch}`;
  }
  return `${process.platform}-${process.arch}`;
}

async function run(): Promise<void> {
  const platformKey = currentPlatformKey();
  const bunTarget = TARGET_BY_PLATFORM.get(platformKey);
  if (!bunTarget) {
    throw new Error(`Unsupported platform for sidecar diagnostics build: ${platformKey}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, process.platform === "win32" ? "diligent-web-server.exe" : "diligent-web-server");
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
  await cp(
    resolve(VALIDATOR_PLUGIN, process.platform === "win32" ? "luau-lsp.exe" : "luau-lsp"),
    resolve(validatorAssetsDir, process.platform === "win32" ? "luau-lsp.exe" : "luau-lsp"),
  );
  await cp(resolve(VALIDATOR_PLUGIN, "overdare-types.d.lua"), resolve(validatorAssetsDir, "overdare-types.d.lua"));

  console.log(outPath);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
