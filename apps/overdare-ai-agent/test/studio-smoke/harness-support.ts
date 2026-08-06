// @summary Provide reusable isolation, timeout, and readiness helpers for the Studio smoke harness.

import { win32 } from "node:path";

export interface IsolatedEnvironmentPaths {
  home: string;
  appData: string;
  localAppData: string;
  temp: string;
}

export function createIsolatedEnv(
  base: NodeJS.ProcessEnv,
  paths: IsolatedEnvironmentPaths,
  executable: string,
): Record<string, string> {
  const systemRoot = base.SystemRoot?.trim() || base.WINDIR?.trim() || String.raw`C:\Windows`;
  const system32 = win32.join(systemRoot, "System32");
  const windowsPowerShell = win32.join(system32, "WindowsPowerShell", "v1.0");
  const homeDrive = paths.home.match(/^[A-Za-z]:/)?.[0] || "C:";
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: base.SystemDrive || "C:",
    ComSpec: win32.join(system32, "cmd.exe"),
    PATHEXT: base.PATHEXT || ".COM;.EXE;.BAT;.CMD",
    PATH: `${win32.dirname(executable)};${system32};${windowsPowerShell}`,
    USERPROFILE: paths.home,
    HOME: paths.home,
    HOMEDRIVE: homeDrive,
    HOMEPATH: paths.home.slice(homeDrive.length) || "\\",
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    DILIGENT_STORAGE_NAMESPACE: "overdare",
    DILIGENT_ENV: "prod",
    STUDIO_HOST: "127.0.0.1",
  };
}

export function createSmokeAgentConfig(): string {
  return `${JSON.stringify({ updateMode: "disabled" }, null, 2)}\n`;
}

export async function withStageTimeout<T>(
  stage: string,
  timeoutMs: number,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`[${stage}] timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`[${stage}] timed out after ${timeoutMs} ms`, { cause: error });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith("[") ? message : `[${stage}] ${message}`, { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isLoadedProjectTree(result: unknown): boolean {
  if (Array.isArray(result)) return result.length > 0;
  if (!result || typeof result !== "object") return false;
  const level = (result as { level?: unknown }).level;
  return Array.isArray(level) && level.length > 0;
}
