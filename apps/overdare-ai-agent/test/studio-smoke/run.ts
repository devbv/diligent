// @summary Run the focused Windows smoke test for a real OVERDARE Studio and the packaged agent sidecar.

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, win32 } from "node:path";
import { WebRpcClient } from "../../sidecar/src/web/client/lib/rpc-client";
import { hashStudioArchive, resolveStudioArchiveCache } from "./archive-cache";
import {
  createStudioLaunchArgs,
  readSmokeContract,
  type SmokeContract,
  STUDIO_DOWNLOAD_TIMEOUT_MS,
  STUDIO_SHIPPING_EXE_RELATIVE_PATH,
} from "./contract";
import { createIsolatedEnv, createSmokeAgentConfig, isLoadedProjectTree, withStageTimeout } from "./harness-support";
import { downloadS3Object, resolveLatestS3StudioRelease } from "./s3-source";
import {
  createStudioFirewallCommands,
  createStudioUrlSchemeCommands,
  stageAppLocalWindowsRuntime,
  stageStudioProjectFixture,
  validateStudioWindowsRuntimeSource,
} from "./windows-runtime";

const configuredRepoRoot = process.env.OVERDARE_SMOKE_REPO_ROOT?.trim();
const REPO_ROOT = configuredRepoRoot ? resolve(configuredRepoRoot) : resolve(import.meta.dir, "../../../..");
const TIMEOUT = {
  download: STUDIO_DOWNLOAD_TIMEOUT_MS,
  extract: 10 * 60_000,
  studioStart: 30_000,
  projectReady: 3 * 60_000,
  agentReady: 60_000,
  smoke: 30_000,
  cleanup: 15_000,
} as const;

interface RunPaths {
  root: string;
  home: string;
  appData: string;
  localAppData: string;
  temp: string;
  project: string;
  logs: string;
  studioUserData: string;
  studioDir: string;
  archive: string;
}

interface LoggedProcess {
  subprocess: Bun.Subprocess;
  closeLogs: () => void;
}

function createRunPaths(root: string): RunPaths {
  const home = join(root, "user");
  return {
    root,
    home,
    appData: join(home, "AppData", "Roaming"),
    localAppData: join(home, "AppData", "Local"),
    temp: join(root, "temp"),
    project: join(root, "project"),
    logs: join(root, "logs"),
    studioUserData: join(root, "studio-user-data"),
    studioDir: join(root, "studio"),
    archive: join(root, "studio.zip"),
  };
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("aborted");
  await new Promise<void>((resolveDelay, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function log(paths: RunPaths, stage: string, message: string, details?: Record<string, unknown>): Promise<void> {
  console.log(`[studio-smoke:${stage}] ${message}`);
  await appendFile(
    join(paths.logs, "harness.jsonl"),
    `${JSON.stringify({ time: new Date().toISOString(), stage, message, ...details })}\n`,
  );
}

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolveConnection(false);
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolveConnection(false);
    });
  });
}

async function killTree(subprocess: Bun.Subprocess | undefined): Promise<void> {
  if (!subprocess || subprocess.exitCode !== null) return;
  const taskkill = join(process.env.SystemRoot || String.raw`C:\Windows`, "System32", "taskkill.exe");
  const killer = Bun.spawn([taskkill, "/PID", String(subprocess.pid), "/T", "/F"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await Promise.race([killer.exited, delay(5000)]).catch(() => {});
  if (killer.exitCode === null) killer.kill();
  await Promise.race([subprocess.exited, delay(5000)]).catch(() => {});
}

async function runCommand(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (signal.aborted) throw new Error("aborted");
  const subprocess = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  signal.addEventListener("abort", () => void killTree(subprocess), { once: true });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function resolveCredentialFile(): string | undefined {
  const configured = process.env.OVERDARE_STUDIO_CREDENTIAL_FILE?.trim();
  if (configured) return resolve(configured);
  const localFixture = join(REPO_ROOT, "apps", "overdare-ai-agent", "test", "studio-smoke", ".credential.local");
  return existsSync(localFixture) ? localFixture : undefined;
}

async function invokeCredentialTool(
  action: "Import" | "Delete",
  paths: RunPaths,
  signal: AbortSignal,
  credentialFile?: string,
): Promise<void> {
  const powerShell = join(
    process.env.SystemRoot || String.raw`C:\Windows`,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const tool =
    process.env.OVERDARE_STUDIO_CREDENTIAL_TOOL?.trim() ||
    join(REPO_ROOT, "apps", "overdare-ai-agent", "test", "studio-smoke", "studio-credential.ps1");
  const command = [powerShell, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tool, "-Action", action];
  if (credentialFile) command.push("-CredentialFile", credentialFile, "-RequireAbsent");
  const result = await runCommand(command, paths.root, createIsolatedEnv(process.env, paths, powerShell), signal);
  if (result.exitCode !== 0) {
    throw new Error(
      `Studio credential ${action.toLowerCase()} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
}

async function importStudioCredential(paths: RunPaths, signal: AbortSignal): Promise<boolean> {
  const credentialFile = resolveCredentialFile();
  if (!credentialFile) return false;
  await invokeCredentialTool("Import", paths, signal, credentialFile);
  try {
    if (process.env.OVERDARE_STUDIO_CREDENTIAL_EPHEMERAL === "1") {
      await rm(credentialFile, { force: true });
    }
  } catch (error) {
    await deleteStudioCredential(paths, signal).catch(() => {});
    throw error;
  }
  return true;
}

async function deleteStudioCredential(paths: RunPaths, signal: AbortSignal): Promise<void> {
  await invokeCredentialTool("Delete", paths, signal);
}

function spawnLogged(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  paths: RunPaths,
  logName = win32.basename(command[0]),
): LoggedProcess {
  const stdoutFd = openSync(join(paths.logs, `${logName}.stdout.log`), "a");
  const stderrFd = openSync(join(paths.logs, `${logName}.stderr.log`), "a");
  let subprocess: Bun.Subprocess;
  try {
    subprocess = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: stdoutFd, stderr: stderrFd });
  } catch (error) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    throw error;
  }
  let closed = false;
  return {
    subprocess,
    closeLogs: () => {
      if (closed) return;
      closed = true;
      closeSync(stdoutFd);
      closeSync(stderrFd);
    },
  };
}

async function stageAgentRuntime(paths: RunPaths): Promise<{ agentExe: string; sidecarExe: string }> {
  const runtimeInput = process.env.OVERDARE_SMOKE_RUNTIME_INPUT?.trim();
  const agentExe = runtimeInput
    ? join(runtimeInput, "overdare-ai-agent.exe")
    : join(REPO_ROOT, "apps", "overdare-ai-agent", "target", "release", "overdare-ai-agent.exe");
  const sidecarDir = runtimeInput
    ? runtimeInput
    : join(REPO_ROOT, "apps", "overdare-ai-agent", ".diligent", "diagnostics");
  const sidecarExe = join(sidecarDir, "diligent-web-server.exe");
  const webDist = runtimeInput
    ? join(runtimeInput, "dist", "client")
    : join(REPO_ROOT, "apps", "overdare-ai-agent", "sidecar", "dist", "client");
  for (const [path, label] of [
    [agentExe, "agent executable"],
    [sidecarExe, "sidecar executable"],
    [webDist, "web distribution"],
  ] as const) {
    if (!existsSync(path)) throw new Error(`Missing ${label}; build it before running the smoke test: ${path}`);
  }

  const storage = join(paths.home, ".overdare");
  const runtime = join(storage, "updates", "runtime");
  await mkdir(storage, { recursive: true });
  await writeFile(join(storage, "config.jsonc"), createSmokeAgentConfig());
  await mkdir(join(runtime, "dist"), { recursive: true });
  const stagedAgentExe = join(runtime, "overdare-ai-agent.exe");
  const stagedSidecarExe = join(runtime, "diligent-web-server.exe");
  await cp(agentExe, stagedAgentExe);
  await cp(sidecarExe, stagedSidecarExe);
  await cp(webDist, join(runtime, "dist", "client"), { recursive: true });
  if (existsSync(join(sidecarDir, "assets"))) {
    await cp(join(sidecarDir, "assets"), join(runtime, "assets"), { recursive: true });
  }
  await writeFile(
    join(runtime, "version.json"),
    `${JSON.stringify({ version: "0.0.0-studio-smoke", applied_at: new Date().toISOString(), sha256: "local" })}\n`,
  );
  return { agentExe: stagedAgentExe, sidecarExe: stagedSidecarExe };
}

async function downloadStudioArchive(contract: SmokeContract, paths: RunPaths, signal: AbortSignal): Promise<string> {
  let sourceDetails: Record<string, unknown>;
  let archivePath = paths.archive;
  let actualSha: string;
  let cacheHit = false;
  if (contract.source.kind === "url") {
    const response = await fetch(contract.source.url, { signal });
    if (!response.ok) throw new Error(`Studio download failed: HTTP ${response.status}`);
    await Bun.write(paths.archive, response);
    actualSha = await hashStudioArchive(paths.archive);
    sourceDetails = { kind: "url", host: new URL(contract.source.url).host };
  } else {
    const source = contract.source;
    const latest = await resolveLatestS3StudioRelease(source, signal);
    await log(paths, "s3-list", "Selected latest Windows Release/Shipping archive", {
      bucket: source.bucket,
      key: latest.key,
      lastModified: latest.lastModified,
      size: latest.size,
    });
    const descriptor = {
      bucket: source.bucket,
      region: source.region,
      key: latest.key,
      lastModified: latest.lastModified,
      size: latest.size,
    };
    const cacheRoot = process.env.OVERDARE_STUDIO_CACHE_DIR?.trim();
    if (cacheRoot) {
      if (latest.size === undefined) throw new Error("S3 object metadata did not include the Studio archive size");
      const cached = await resolveStudioArchiveCache({
        cacheRoot,
        descriptor: { ...descriptor, size: latest.size },
        expectedSha256: contract.studioSha256,
        download: (path) => downloadS3Object(source, latest.key, path, signal),
      });
      archivePath = cached.archivePath;
      actualSha = cached.sha256;
      cacheHit = cached.cacheHit;
      await log(
        paths,
        cached.cacheHit ? "cache-hit" : "cache-miss",
        cached.cacheHit
          ? "Reused the validated Windows Studio archive"
          : "Downloaded and cached the changed Windows Studio archive",
      );
    } else {
      await downloadS3Object(source, latest.key, paths.archive, signal);
      actualSha = await hashStudioArchive(paths.archive);
    }
    sourceDetails = {
      kind: "s3",
      ...descriptor,
    };
  }

  if (contract.studioSha256 && actualSha !== contract.studioSha256) {
    throw new Error(`Studio SHA-256 mismatch: expected ${contract.studioSha256}, received ${actualSha}`);
  }
  await writeFile(
    join(paths.logs, "studio-archive.json"),
    `${JSON.stringify(
      {
        ...sourceDetails,
        sha256: actualSha,
        checksumPinned: Boolean(contract.studioSha256),
        cacheHit,
      },
      null,
      2,
    )}\n`,
  );
  if (signal.aborted) throw new Error("aborted");
  return archivePath;
}

async function extractStudioArchive(paths: RunPaths, archivePath: string, signal: AbortSignal): Promise<string> {
  const tar = join(process.env.SystemRoot || String.raw`C:\Windows`, "System32", "tar.exe");
  if (!existsSync(tar)) throw new Error(`Missing Windows archive extractor: ${tar}`);
  const result = await runCommand(
    [tar, "-xf", archivePath, "-C", paths.studioDir],
    paths.root,
    createIsolatedEnv(process.env, paths, tar),
    signal,
  );
  if (result.exitCode !== 0) throw new Error(`tar.exe extraction failed: ${result.stderr.trim()}`);

  const executable = resolve(paths.studioDir, STUDIO_SHIPPING_EXE_RELATIVE_PATH);
  const [realRoot, realExecutable] = await Promise.all([realpath(paths.studioDir), realpath(executable)]);
  if (relative(realRoot, realExecutable).startsWith("..") || !(await stat(realExecutable)).isFile()) {
    throw new Error("Studio executable resolved outside the extracted archive");
  }
  return realExecutable;
}

async function configureStudioFirewall(
  paths: RunPaths,
  studioExe: string,
  runtimeExecutables: string[],
  signal: AbortSignal,
): Promise<void> {
  const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || String.raw`C:\Windows`;
  for (const command of createStudioFirewallCommands(systemRoot, paths.studioDir, studioExe, runtimeExecutables)) {
    const executable = command[8].slice("program=".length);
    if (!existsSync(executable)) continue;
    const result = await runCommand(command, paths.root, createIsolatedEnv(process.env, paths, command[0]), signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not allow Studio through Windows Firewall: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }
}

async function configureStudioUrlScheme(paths: RunPaths, studioExe: string, signal: AbortSignal): Promise<void> {
  const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || String.raw`C:\Windows`;
  for (const command of createStudioUrlSchemeCommands(systemRoot, studioExe)) {
    const result = await runCommand(command, paths.root, createIsolatedEnv(process.env, paths, command[0]), signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not register the Studio login callback scheme: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }
}

async function waitForStudioProcess(studio: Bun.Subprocess, signal: AbortSignal): Promise<void> {
  await delay(2000, signal);
  if (studio.exitCode !== null) throw new Error(`Studio exited with code ${studio.exitCode}`);
}

async function waitForInteractiveCredentialCapture(studio: Bun.Subprocess): Promise<never> {
  console.log("Studio is ready for the one-time authentication bootstrap. Sign in with the dedicated test account.");
  while (studio.exitCode === null) await delay(1000);
  throw new Error(`[auth-bootstrap] Studio exited with code ${studio.exitCode} before a credential was captured`);
}

interface ProjectReadiness {
  tcpConnected: boolean;
  lastError: string;
}

async function waitForProject(
  port: number,
  studio: Bun.Subprocess,
  signal: AbortSignal,
  readiness: ProjectReadiness,
): Promise<unknown> {
  const { call: callStudioRpc } = await import("../../sidecar/src/tools/studiorpc/rpc");
  while (!signal.aborted) {
    if (studio.exitCode !== null) throw new Error(`Studio exited with code ${studio.exitCode}: ${readiness.lastError}`);
    if (!(await canConnect(port))) {
      await delay(500, signal);
      continue;
    }
    readiness.tcpConnected = true;
    try {
      const result = await callStudioRpc("level.browse", {});
      if (isLoadedProjectTree(result)) return result;
      readiness.lastError = "level.browse returned an empty tree";
    } catch (error) {
      readiness.lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500, signal);
  }
  throw new Error(readiness.lastError);
}

async function waitForAgent(port: number, agent: Bun.Subprocess, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    if (agent.exitCode !== null) throw new Error(`agent exited with code ${agent.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, { signal })).ok) return;
    } catch {}
    await delay(250, signal);
  }
}

async function verifyAgentTools(port: number, signal: AbortSignal): Promise<string[]> {
  const client = new WebRpcClient(`ws://127.0.0.1:${port}/rpc`);
  signal.addEventListener("abort", () => client.disconnect(), { once: true });
  try {
    await client.connect();
    await client.initialize({ clientName: "studio-smoke", clientVersion: "1.0.0", protocolVersion: 1 });
    const result = await client.request("tools/list", {});
    return result.tools.map((tool) => tool.name);
  } finally {
    client.disconnect();
  }
}

async function invokeStudioTool(paths: RunPaths): Promise<void> {
  const { runOverdareToolsCli } = await import("../../scripts/lib/overdare-tools-cli");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runOverdareToolsCli(
    ["run", "studiorpc_level_browse", "--args", "{}", "--json", "--yes", "--cwd", paths.project],
    {
      stdout: { log: (text) => stdout.push(text) },
      stderr: { error: (text) => stderr.push(text), write: (text) => stderr.push(text) },
    },
  );
  await Promise.all([
    writeFile(join(paths.logs, "studiorpc-level-browse.stdout.log"), stdout.join("\n")),
    writeFile(join(paths.logs, "studiorpc-level-browse.stderr.log"), stderr.join("\n")),
  ]);
  if (exitCode !== 0 || !stdout.join("\n").includes("level.browse")) {
    throw new Error(`studiorpc_level_browse failed: ${stderr.join("\n")}`);
  }
}

export function redactStudioDiagnostic(value: string): string {
  return value
    .replace(/-AUTH_PASSWORD=(?:"[^"]*"|\S+)/gi, "-AUTH_PASSWORD=[REDACTED]")
    .replace(/("[^"]*(?:token|password|secret|authorization)[^"]*"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
    .replace(
      /\b((?:access|refresh|id)_?token|OverdareLogintoken)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/(Authorization\s*:\s*Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
}

async function copySanitizedTextTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copySanitizedTextTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await writeFile(destinationPath, redactStudioDiagnostic(await readFile(sourcePath, "utf8")));
    }
  }
}

async function preserveStudioLogs(paths: RunPaths, destination: string): Promise<void> {
  const source = join(paths.localAppData, "Sandbox", "Saved", "Logs");
  const explicitLog = join(paths.studioUserData, "studio.log");
  if (existsSync(source)) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".log")) continue;
      const content = await readFile(join(source, entry.name), "utf8");
      await writeFile(join(destination, entry.name), redactStudioDiagnostic(content));
    }
  }
  if (existsSync(explicitLog)) {
    await mkdir(destination, { recursive: true });
    const content = await readFile(explicitLog, "utf8");
    await writeFile(join(destination, "studio.log"), redactStudioDiagnostic(content));
  }
}

async function preserveFailure(
  contract: SmokeContract,
  paths: RunPaths,
  runId: string,
  failure: unknown,
): Promise<string> {
  const destination = join(contract.artifactRoot, runId);
  await mkdir(destination, { recursive: true });
  await writeFile(
    join(destination, "failure.json"),
    `${JSON.stringify(
      {
        message: redactStudioDiagnostic(failure instanceof Error ? failure.message : String(failure)),
        stack: failure instanceof Error && failure.stack ? redactStudioDiagnostic(failure.stack) : undefined,
      },
      null,
      2,
    )}\n`,
  );
  if (existsSync(paths.logs)) await copySanitizedTextTree(paths.logs, join(destination, "logs"));
  await preserveStudioLogs(paths, join(destination, "studio-logs"));
  const agentLogs = join(paths.home, ".overdare", "logs");
  if (existsSync(agentLogs)) await copySanitizedTextTree(agentLogs, join(destination, "agent-logs"));
  return destination;
}

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("OVERDARE Studio smoke test requires Windows");
  const authBootstrap = process.env.OVERDARE_STUDIO_AUTH_BOOTSTRAP === "1";
  const contract = readSmokeContract();
  validateStudioWindowsRuntimeSource(contract.windowsRuntimeDir);
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const paths = createRunPaths(await mkdtemp(join(tmpdir(), "overdare-studio-smoke-")));
  await Promise.all(
    [
      paths.home,
      paths.appData,
      paths.localAppData,
      paths.temp,
      paths.project,
      paths.logs,
      paths.studioUserData,
      paths.studioDir,
    ].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(join(paths.logs, "harness.jsonl"), "");

  let studio: LoggedProcess | undefined;
  let agent: LoggedProcess | undefined;
  let rpcPort: number | undefined;
  let agentPort: number | undefined;
  let credentialImported = false;
  let failure: unknown;

  try {
    if (!authBootstrap) {
      credentialImported = await withStageTimeout("credential-import", 30_000, (signal) =>
        importStudioCredential(paths, signal),
      );
      await log(
        paths,
        "credential-import",
        credentialImported ? "Injected the isolated Studio credential" : "No Studio credential fixture was configured",
      );
    }
    const agentRuntime = authBootstrap
      ? undefined
      : await withStageTimeout("prepare", 30_000, () => stageAgentRuntime(paths));
    const archivePath = await withStageTimeout("download", TIMEOUT.download, (signal) =>
      downloadStudioArchive(contract, paths, signal),
    );
    await log(paths, "download", "Studio archive resolved and hashed");
    const studioExe = await withStageTimeout("extract", TIMEOUT.extract, (signal) =>
      extractStudioArchive(paths, archivePath, signal),
    );
    await log(paths, "extract", "Studio archive extracted");
    const fixture = await withStageTimeout("fixture", 30_000, () =>
      stageStudioProjectFixture(paths.studioDir, paths.project),
    );
    await log(paths, "fixture", "Bundled Baseplate project fixture staged");
    const runtimeDependencyTargets = [
      win32.dirname(studioExe),
      ...(agentRuntime ? [win32.dirname(agentRuntime.agentExe), win32.dirname(agentRuntime.sidecarExe)] : []),
    ];
    await stageAppLocalWindowsRuntime(contract.windowsRuntimeDir, runtimeDependencyTargets);
    await log(paths, "runtime", "Staged the signed Microsoft runtimes beside the disposable smoke executables");
    const runtimeExecutables = agentRuntime ? [agentRuntime.agentExe, agentRuntime.sidecarExe] : [];
    await withStageTimeout("firewall", 30_000, (signal) =>
      configureStudioFirewall(paths, studioExe, runtimeExecutables, signal),
    );
    await log(paths, "firewall", "Allowed smoke executables through the disposable Windows Sandbox firewall");
    await withStageTimeout("url-scheme", 30_000, (signal) => configureStudioUrlScheme(paths, studioExe, signal));
    await log(paths, "url-scheme", "Registered the Studio login callback scheme for the disposable profile");

    rpcPort = contract.studioRpcPort;
    process.env.STUDIO_HOST = "127.0.0.1";
    process.env.STUDIO_PORT = String(rpcPort);
    const studioEnv = createIsolatedEnv(process.env, paths, studioExe);
    studioEnv.STUDIO_PORT = String(rpcPort);
    const studioArgs = createStudioLaunchArgs(
      contract.studioArgs,
      {
        projectDir: paths.project,
        projectMap: fixture.mapPath,
        rpcPort,
        logDir: paths.logs,
        userDataDir: paths.studioUserData,
      },
      { unattended: !authBootstrap },
    );
    await writeFile(
      join(paths.logs, "studio-command.json"),
      `${JSON.stringify({ executable: studioExe, args: studioArgs.map(redactStudioDiagnostic) }, null, 2)}\n`,
    );
    studio = spawnLogged([studioExe, ...studioArgs], paths.project, studioEnv, paths);
    await withStageTimeout("studio-start", TIMEOUT.studioStart, (signal) =>
      waitForStudioProcess(studio!.subprocess, signal),
    );
    await log(paths, "studio-start", "Studio process started");

    if (authBootstrap) {
      await log(paths, "auth-bootstrap", "Waiting for interactive login and credential capture");
      await waitForInteractiveCredentialCapture(studio.subprocess);
    }

    const readiness: ProjectReadiness = {
      tcpConnected: false,
      lastError: "Studio RPC port has not accepted a connection",
    };
    let tree: unknown;
    try {
      tree = await withStageTimeout("project-ready", TIMEOUT.projectReady, (signal) =>
        waitForProject(rpcPort!, studio!.subprocess, signal, readiness),
      );
    } finally {
      await writeFile(join(paths.logs, "project-readiness.json"), `${JSON.stringify(readiness, null, 2)}\n`);
    }
    await writeFile(join(paths.logs, "project-ready.json"), `${JSON.stringify(tree, null, 2)}\n`);

    if (!agentRuntime) throw new Error("[prepare] agent runtime was not staged");
    const { agentExe } = agentRuntime;
    agentPort = await allocatePort();
    agent = spawnLogged(
      [
        agentExe,
        "--agent-env=prod",
        "start",
        `--cwd=${paths.project}`,
        `--studio-rpc-port=${rpcPort}`,
        `--web-server-port=${agentPort}`,
      ],
      paths.project,
      createIsolatedEnv(process.env, paths, agentExe),
      paths,
    );
    await withStageTimeout("agent-ready", TIMEOUT.agentReady, (signal) =>
      waitForAgent(agentPort!, agent!.subprocess, signal),
    );

    const tools = await withStageTimeout("agent-tools", TIMEOUT.smoke, (signal) =>
      verifyAgentTools(agentPort!, signal),
    );
    await writeFile(join(paths.logs, "agent-tools.json"), `${JSON.stringify(tools, null, 2)}\n`);
    if (!tools.includes("studiorpc_level_browse")) {
      throw new Error("[agent-tools] studiorpc_level_browse is missing");
    }
    await withStageTimeout("smoke-call", TIMEOUT.smoke, () => invokeStudioTool(paths));
    await log(paths, "complete", "Studio RPC and agent smoke checks passed");
  } catch (error) {
    failure = error;
    await log(paths, "failure", error instanceof Error ? error.message : String(error));
  }

  try {
    await withStageTimeout("cleanup", TIMEOUT.cleanup, async (signal) => {
      try {
        await Promise.all([killTree(agent?.subprocess), killTree(studio?.subprocess)]);
        agent?.closeLogs();
        studio?.closeLogs();
        await delay(500, signal);
        if ((rpcPort && (await canConnect(rpcPort))) || (agentPort && (await canConnect(agentPort)))) {
          throw new Error("a smoke-test port remained open");
        }
      } finally {
        if (credentialImported) await deleteStudioCredential(paths, signal);
      }
    });
  } catch (error) {
    agent?.closeLogs();
    studio?.closeLogs();
    failure ??= error;
  }

  if (failure) {
    try {
      const diagnostics = await preserveFailure(contract, paths, runId, failure);
      console.error(`Studio smoke diagnostics: ${diagnostics}`);
    } catch (error) {
      console.error(`Could not preserve smoke diagnostics: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await rm(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  if (failure) throw failure;
  console.log(`OVERDARE Studio smoke test passed (${runId})`);
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
