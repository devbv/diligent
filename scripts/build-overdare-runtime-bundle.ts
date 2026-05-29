// @summary Build an OVERDARE runtime bundle zip for overdare-ai-agent releases.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const WEB = resolve(ROOT, "packages/web");
const OVERDARE_CLI = resolve(ROOT, "apps/overdare-ai-agent");
const DIST = resolve(ROOT, "dist");
const DIAGNOSTICS_DIR = resolve(OVERDARE_CLI, ".diligent/diagnostics");
const BOOTSTRAP_DIR = resolve(OVERDARE_CLI, "bootstrap");
const PLUGINS_DIR = resolve(OVERDARE_CLI, "plugins");
const VALIDATOR_PLUGIN = resolve(PLUGINS_DIR, "plugin-validator");

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
      env: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const version = values.version?.trim();
  const platformId = values.platform?.trim();
  const envRaw = values.env?.trim();
  if (!version) throw new Error("Missing required --version <semver>");
  if (!platformId) throw new Error("Missing required --platform <platform-id>");
  if (!envRaw) throw new Error("Missing required --env <prod|dev>");
  if (envRaw !== "prod" && envRaw !== "dev") {
    throw new Error(`Invalid --env value: '${envRaw}' (expected 'prod' or 'dev')`);
  }
  const platform = PLATFORM_BY_ID.get(platformId);
  if (!platform) throw new Error(`Unsupported platform: ${platformId}`);
  return { version, platform, env: envRaw };
}

function ensureWebClientBuilt(): void {
  const clientDist = resolve(WEB, "dist/client");
  if (existsSync(clientDist)) return;
  run(["bun", "run", "build"], WEB);
}

function buildSidecar(platform: PlatformConfig): string {
  const target = resolve(DIAGNOSTICS_DIR, `diligent-web-server-${platform.id}${platform.ext}`);
  run(["bun", "run", "scripts/build-overdare-sidecar.ts", `--platform=${platform.id}`, `--outfile=${target}`], ROOT);
  if (!existsSync(target)) {
    throw new Error(`Built sidecar not found: ${target}`);
  }
  return target;
}

function createPluginBundle(pluginDir: string, outDir: string): void {
  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8")) as { name: string; version: string };
  mkdirSync(outDir, { recursive: true });
  run(["bun", "build", "src/index.ts", "--target", "bun", "--outfile", join(outDir, "index.js")], pluginDir);
  writeFileSync(
    join(outDir, "package.json"),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", main: "index.js" }, null, 2)}\n`,
  );
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (["package.json", "tsconfig.json", "bun.lock", "bun.lockb"].includes(entry.name)) continue;
    if (entry.name.endsWith(".ts")) continue;
    cpSync(join(pluginDir, entry.name), join(outDir, entry.name));
  }
}

function stageBootstrap(stageDir: string): void {
  const defaultsOut = join(stageDir, "defaults");
  cpSync(BOOTSTRAP_DIR, defaultsOut, { recursive: true });
  const bundledPluginsRoot = join(defaultsOut, "plugins", "@overdare");
  mkdirSync(bundledPluginsRoot, { recursive: true });
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    createPluginBundle(join(PLUGINS_DIR, entry.name), join(bundledPluginsRoot, entry.name));
  }
}

function maybeStageRg(platform: PlatformConfig, stageDir: string): void {
  if (!platform.rgBinaryName) return;
  const source = resolve(ROOT, "thirdparty/rg", platform.rgBinaryName);
  if (!existsSync(source)) return;
  const target = join(stageDir, `rg${platform.ext}`);
  cpSync(source, target);
}

function stageSidecarAssets(platform: PlatformConfig, stageDir: string): void {
  const validatorDir = join(stageDir, "validator");
  mkdirSync(validatorDir, { recursive: true });
  const luauLspName = platform.id === "windows-x64" ? "luau-lsp.exe" : "luau-lsp";
  cpSync(resolve(VALIDATOR_PLUGIN, luauLspName), join(validatorDir, luauLspName));
  cpSync(resolve(VALIDATOR_PLUGIN, "overdare-types.d.lua"), join(validatorDir, "overdare-types.d.lua"));
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
  cpSync(resolve(WEB, "dist/client"), join(stageDir, "dist/client"), { recursive: true });
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
