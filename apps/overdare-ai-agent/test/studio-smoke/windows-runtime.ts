// @summary Prepare disposable Windows runtime dependencies and registrations for Studio smoke tests.

import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { join, win32 } from "node:path";

export function createStudioPrerequisiteCommand(studioDir: string, logDir: string): string[] {
  return [
    win32.join(studioDir, "Engine", "Extras", "Redist", "en-us", "UEPrereqSetup_x64.exe"),
    "/quiet",
    "/norestart",
    "/log",
    win32.join(logDir, "ue-prerequisites.log"),
  ];
}

export function createStudioFirewallCommands(
  systemRoot: string,
  studioDir: string,
  studioExe: string,
  runtimeExecutables: string[] = [],
): string[][] {
  const netsh = win32.join(systemRoot, "System32", "netsh.exe");
  const executables = [
    studioExe,
    win32.join(studioDir, "Sandbox", "Binaries", "Win64", "Sandbox-Win64-Shipping.exe"),
    win32.join(studioDir, "Sandbox", "OverdareAIAgent", "overdare-ai-agent.exe"),
    ...runtimeExecutables,
  ];
  const seen = new Set<string>();
  return executables
    .filter((executable) => {
      const normalized = executable.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .map((executable, index) => [
      netsh,
      "advfirewall",
      "firewall",
      "add",
      "rule",
      `name=OVERDARE Studio Smoke ${index + 1}`,
      "dir=in",
      "action=allow",
      `program=${executable}`,
      "enable=yes",
      "profile=any",
    ]);
}

export function createStudioUrlSchemeCommands(systemRoot: string, studioExe: string): string[][] {
  const reg = win32.join(systemRoot, "System32", "reg.exe");
  return [
    [reg, "add", String.raw`HKCR\ovdrstudio`, "/v", "URL protocol", "/d", "", "/f"],
    [reg, "add", String.raw`HKCR\ovdrstudio\shell\open\command`, "/ve", "/d", `"${studioExe}" "%1"`, "/f"],
  ];
}

export interface SuppressedStudioPrerequisites {
  installer: string;
  suppressedInstaller: string;
}

export async function suppressInteractiveStudioPrerequisites(
  studioDir: string,
  stubExecutable = join(process.env.SystemRoot || String.raw`C:\Windows`, "System32", "whoami.exe"),
): Promise<SuppressedStudioPrerequisites | undefined> {
  const installer = createStudioPrerequisiteCommand(studioDir, studioDir)[0];
  if (!existsSync(installer)) return undefined;
  if (!existsSync(stubExecutable)) throw new Error(`Missing prerequisite suppression stub: ${stubExecutable}`);
  const suppressedInstaller = `${installer}.studio-smoke-disabled`;
  await rename(installer, suppressedInstaller);
  await cp(stubExecutable, installer);
  return { installer, suppressedInstaller };
}

const STUDIO_VC_RUNTIME_FILES = [
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_2.dll",
  "msvcp140_atomic_wait.dll",
  "msvcp140_codecvt_ids.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
] as const;

export async function stageStudioRuntimeDependencies(
  studioDir: string,
  xinputSource: string,
  additionalTargetDirs: string[] = [],
): Promise<void> {
  if (!existsSync(xinputSource)) throw new Error(`Missing mapped XInput runtime: ${xinputSource}`);
  const vcSourceDir = join(
    studioDir,
    "Engine",
    "Plugins",
    "LuaMachine",
    "Source",
    "ThirdParty",
    "lua-language-server",
    "bin",
  );
  const targetDirs = [studioDir, join(studioDir, "Sandbox", "Binaries", "Win64"), ...additionalTargetDirs];
  for (const targetDir of targetDirs) {
    await mkdir(targetDir, { recursive: true });
    await cp(xinputSource, join(targetDir, "xinput1_3.dll"));
    for (const name of STUDIO_VC_RUNTIME_FILES) {
      const source = join(vcSourceDir, name);
      if (!existsSync(source)) throw new Error(`Studio archive is missing the bundled VC runtime: ${source}`);
      await cp(source, join(targetDir, name));
    }
  }
}

export async function restoreInteractiveStudioPrerequisites(
  suppressed: SuppressedStudioPrerequisites | undefined,
): Promise<void> {
  if (!suppressed) return;
  await rm(suppressed.installer, { force: true });
  await rename(suppressed.suppressedInstaller, suppressed.installer);
}

export function shouldInstallStudioPrerequisites(exitCode: number | null): boolean {
  return exitCode !== null && exitCode >>> 0 === 0xc0000135;
}

export async function stageStudioProjectFixture(studioDir: string, projectDir: string): Promise<{ mapPath: string }> {
  const templateDir = join(studioDir, "Sandbox", "EditorResource", "Sandbox", "WorldTemplate", "Baseplate");
  const sourceMap = join(templateDir, "Baseplate.umap");
  const sourceMetadata = join(templateDir, "Baseplate.ovdrm");
  for (const [path, label] of [
    [sourceMap, "Baseplate map"],
    [sourceMetadata, "Baseplate metadata"],
  ] as const) {
    if (!existsSync(path)) throw new Error(`Studio archive is missing the bundled ${label}: ${path}`);
  }

  const mapPath = join(projectDir, "project.umap");
  await mkdir(projectDir, { recursive: true });
  await cp(sourceMap, mapPath);
  await cp(sourceMetadata, join(projectDir, "Baseplate.ovdrm"));
  return { mapPath };
}
