// @summary Build an OVERDARE runtime bundle zip for overdare-ai-agent releases.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const OVERDARE_CLI = resolve(ROOT, "apps/overdare-ai-agent");
const SIDECAR = resolve(OVERDARE_CLI, "sidecar");
const DIST = resolve(ROOT, "dist");
const DIAGNOSTICS_DIR = resolve(OVERDARE_CLI, ".diligent/diagnostics");
const BOOTSTRAP_DIR = resolve(OVERDARE_CLI, "bootstrap");
const SIDECAR_ASSETS = resolve(OVERDARE_CLI, "sidecar/assets");
const VENDORED_LUAU_VERSION = "0.723";
const VENDORED_LUAU_DIR = resolve(OVERDARE_CLI, "sidecar/vendor/luau", VENDORED_LUAU_VERSION);

const LUAU_VENDOR_SUBDIR_BY_PLATFORM = new Map<string, string>([
  ["darwin-arm64", "darwin"],
  ["linux-x64", "linux"],
  ["windows-x64", "win32"],
]);

type PlatformConfig = {
  id: string;
  bunTarget: string;
  ext: string;
  rgBinaryName?: string;
};

const PLATFORM_BY_ID = new Map<string, PlatformConfig>([
  [
    "darwin-arm64",
    { id: "darwin-arm64", bunTarget: "bun-darwin-arm64", ext: "", rgBinaryName: "rg-aarch64-apple-darwin" },
  ],
  ["darwin-x64", { id: "darwin-x64", bunTarget: "bun-darwin-x64", ext: "" }],
  ["linux-x64", { id: "linux-x64", bunTarget: "bun-linux-x64", ext: "" }],
  [
    "windows-x64",
    { id: "windows-x64", bunTarget: "bun-windows-x64", ext: ".exe", rgBinaryName: "rg-x86_64-pc-windows-msvc.exe" },
  ],
]);

function run(command: string[], cwd: string): void {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
}

type ReleaseEnv = "prod" | "dev";

function parseCliOptions(argv: string[]): {
  version: string;
  platform: PlatformConfig;
  env: ReleaseEnv;
} {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: "string" },
      platform: { type: "string" },
      "agent-env": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const version = values.version?.trim();
  const platformId = values.platform?.trim();
  const envRaw = values["agent-env"]?.trim();
  if (!version) throw new Error("Missing required --version <semver>");
  if (!platformId) throw new Error("Missing required --platform <platform-id>");
  if (!envRaw) throw new Error("Missing required --agent-env <prod|dev>");
  if (envRaw !== "prod" && envRaw !== "dev") {
    throw new Error(`Invalid --agent-env value: '${envRaw}' (expected 'prod' or 'dev')`);
  }
  const platform = PLATFORM_BY_ID.get(platformId);
  if (!platform) throw new Error(`Unsupported platform: ${platformId}`);
  return { version, platform, env: envRaw };
}

function ensureWebClientBuilt(): void {
  const clientDist = resolve(SIDECAR, "dist/client");
  if (existsSync(clientDist)) return;
  run(["bun", "run", "web:build"], SIDECAR);
}

/** Stages the Vite client at the installed runtime's stable dist/client path. */
export function stageWebClient(clientDist: string, stageDir: string): void {
  const indexHtml = join(clientDist, "index.html");
  if (!existsSync(indexHtml)) {
    throw new Error(`Web client build is missing ${indexHtml}`);
  }
  cpSync(clientDist, join(stageDir, "dist", "client"), { recursive: true });
}

function buildSidecar(platform: PlatformConfig): string {
  const target = resolve(DIAGNOSTICS_DIR, `diligent-web-server-${platform.id}${platform.ext}`);
  run(["bun", "run", "scripts/build-overdare-sidecar.ts", `--platform=${platform.id}`, `--outfile=${target}`], ROOT);
  if (!existsSync(target)) {
    throw new Error(`Built sidecar not found: ${target}`);
  }
  return target;
}

function stageBootstrap(stageDir: string): void {
  const defaultsOut = join(stageDir, "defaults");
  cpSync(BOOTSTRAP_DIR, defaultsOut, { recursive: true });
}

function maybeStageRg(platform: PlatformConfig, stageDir: string): void {
  if (!platform.rgBinaryName) return;
  const source = resolve(ROOT, "thirdparty/rg", platform.rgBinaryName);
  if (!existsSync(source)) return;
  const binDir = join(stageDir, "assets", "bin");
  mkdirSync(binDir, { recursive: true });
  const target = join(binDir, `rg${platform.ext}`);
  cpSync(source, target);
}

export function stageSidecarAssets(platform: PlatformConfig, stageDir: string): void {
  const binDir = join(stageDir, "assets", "bin");
  const luaDir = join(stageDir, "assets", "lua");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(luaDir, { recursive: true });
  const luauLspName = platform.id === "windows-x64" ? "luau-lsp.exe" : "luau-lsp";
  cpSync(resolve(SIDECAR_ASSETS, "bin", luauLspName), join(binDir, luauLspName));
  const luauVendorSubdir = LUAU_VENDOR_SUBDIR_BY_PLATFORM.get(platform.id);
  if (luauVendorSubdir) {
    const luauName = platform.id === "windows-x64" ? "luau.exe" : "luau";
    cpSync(resolve(VENDORED_LUAU_DIR, luauVendorSubdir, luauName), join(binDir, luauName));
  }
  cpSync(resolve(SIDECAR_ASSETS, "lua", "overdare-types.d.lua"), join(luaDir, "overdare-types.d.lua"));
  // Procedural runner + Luau dependencies must live on real disk for the external
  // luau subprocess (import.meta.url points into Bun's embedded FS in the compiled
  // binary). runtime.ts (resolveLuauRunnerDir) resolves this beside the executable.
  cpSync(resolve(OVERDARE_CLI, "sidecar/src/procedural/luau"), join(luaDir, "procedural"), { recursive: true });
}

function zipRuntimeBundle(stageDir: string, outPath: string): void {
  if (process.platform === "win32") {
    run(
      ["powershell", "-Command", `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${outPath}' -Force`],
      ROOT,
    );
    return;
  }
  run(["zip", "-r", outPath, "."], stageDir);
}

async function main(): Promise<void> {
  const { version, platform, env } = parseCliOptions(process.argv.slice(2));
  await mkdir(DIST, { recursive: true });
  ensureWebClientBuilt();
  const sidecarPath = buildSidecar(platform);

  const stageDir = resolve(DIST, `runtime-${env}-${platform.id}`);
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  cpSync(sidecarPath, join(stageDir, `diligent-web-server${platform.ext}`));
  stageWebClient(resolve(SIDECAR, "dist/client"), stageDir);
  stageSidecarAssets(platform, stageDir);
  stageBootstrap(stageDir);
  maybeStageRg(platform, stageDir);

  const artifactName = `overdare-ai-agent-runtime-${env}-${version}-${platform.id}.zip`;
  const artifactPath = join(DIST, artifactName);
  if (existsSync(artifactPath)) rmSync(artifactPath, { force: true });
  zipRuntimeBundle(stageDir, artifactPath);
  rmSync(stageDir, { recursive: true, force: true });

  const stat = statSync(artifactPath);
  console.log(`${artifactPath} (${stat.size} bytes)`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
