// @summary Prepare disposable Windows runtime dependencies and registrations for Studio smoke tests.

import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { join, win32 } from "node:path";

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

export const STUDIO_WINDOWS_RUNTIME_FILES = [
  "xinput1_3.dll",
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_2.dll",
  "msvcp140_atomic_wait.dll",
  "msvcp140_codecvt_ids.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
] as const;

export function validateStudioWindowsRuntimeSource(sourceDir: string): void {
  for (const name of STUDIO_WINDOWS_RUNTIME_FILES) {
    const source = join(sourceDir, name);
    if (!existsSync(source)) throw new Error(`Missing Windows runtime dependency: ${source}`);
  }
}

export async function stageAppLocalWindowsRuntime(sourceDir: string, targetDirs: readonly string[]): Promise<void> {
  validateStudioWindowsRuntimeSource(sourceDir);
  const sources = STUDIO_WINDOWS_RUNTIME_FILES.map((name) => ({ name, path: join(sourceDir, name) }));
  const seenTargets = new Set<string>();
  for (const targetDir of targetDirs) {
    const normalizedTarget = win32.normalize(targetDir).toLowerCase();
    if (seenTargets.has(normalizedTarget)) continue;
    seenTargets.add(normalizedTarget);
    await mkdir(targetDir, { recursive: true });
    for (const source of sources) {
      await cp(source.path, join(targetDir, source.name));
    }
  }
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
