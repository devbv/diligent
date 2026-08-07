// @summary Test Windows Sandbox and credential entrypoint wiring for Studio smoke runs.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("Studio smoke entrypoints", () => {
  test("use Windows Sandbox as the public Studio smoke entrypoint", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const packageJson = await Bun.file(resolve(repoRoot, "package.json")).json();
    const sandboxWrapper = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/open-windows-sandbox.ps1"),
    ).text();
    const sandboxBootstrap = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/sandbox-bootstrap.ps1"),
    ).text();
    const smokeRunner = await Bun.file(resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/run.ts")).text();
    const runtimePreparer = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/prepare-windows-runtime.ps1"),
    ).text();
    const freshPcSetup = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/setup-windows-smoke.ps1"),
    ).text();
    const credentialTool = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/studio-credential.ps1"),
    ).text();
    const gitignore = await Bun.file(resolve(repoRoot, ".gitignore")).text();

    expect(packageJson.scripts["test:studio-smoke"]).toContain("open-windows-sandbox.ps1");
    expect(packageJson.scripts["test:studio-auth-bootstrap"]).toContain("-AuthBootstrap");
    expect(packageJson.scripts["setup:studio-smoke"]).toContain("setup-windows-smoke.ps1");
    expect(sandboxWrapper).toContain("sandbox-env.json");
    expect(sandboxWrapper).toContain("C:\\studio-smoke-bridge\\sandbox-bootstrap.ps1");
    expect(sandboxWrapper).toContain('"OVERDARE_STUDIO_WINDOWS_RUNTIME_DIR"');
    expect(sandboxWrapper).toContain('"OVERDARE_STUDIO_CREDENTIAL_TOOL"');
    expect(sandboxWrapper).toContain("prepare-windows-runtime.ps1");
    expect(sandboxWrapper).toContain("<VGpu>Disable</VGpu>");
    expect(sandboxWrapper).not.toContain("<SandboxFolder>C:\\workspace\\diligent</SandboxFolder>");
    expect(sandboxBootstrap).toContain("Remove-Item -LiteralPath $ConfigPath -Force");
    expect(sandboxBootstrap).not.toContain("VC\\Runtimes\\x64");
    expect(sandboxBootstrap).toContain('"OverdareLogintoken"');
    expect(sandboxBootstrap).toContain("cancel-requested");
    expect(smokeRunner).toContain("unattended: !authBootstrap");
    expect(runtimePreparer).toContain("APR2007_xinput_x64.cab");
    expect(runtimePreparer).toContain("053F76DCBB28802E23341B6A787E3B0791C0FA5C8D4D011B1044172DBF89C73B");
    expect(runtimePreparer).not.toContain("DXSETUP.exe");
    expect(freshPcSetup).toContain("Get-WindowsOptionalFeature");
    expect(freshPcSetup).toContain("Enable-WindowsOptionalFeature");
    expect(freshPcSetup).toContain("--frozen-lockfile");
    expect(freshPcSetup).toContain("overdare-ai-agent:build-sidecar");
    expect(freshPcSetup).toContain("-AuthBootstrap");
    expect(freshPcSetup).toContain("RunSmoke");
    expect(credentialTool).toContain("CredReadW");
    expect(credentialTool).toContain("CredWriteW");
    expect(credentialTool).toContain("OVERDARE_STUDIO_CREDENTIAL_V1");
    expect(gitignore).toContain(".env.*");
    expect(gitignore).toContain("**/.credential.local");
  });

  // `packages/web` was folded into the sidecar by the web consolidation refactor. Its build
  // outputs survive locally because they are gitignored, so a stale checkout can satisfy the
  // launcher while a fresh clone cannot. Pin both ends of the path to the sidecar instead.
  test("stage the web client from the sidecar build output", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const packageJson = await Bun.file(resolve(repoRoot, "package.json")).json();
    const sandboxWrapper = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/open-windows-sandbox.ps1"),
    ).text();
    const freshPcSetup = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/setup-windows-smoke.ps1"),
    ).text();
    const guide = await Bun.file(resolve(repoRoot, "docs/guide/overdare-studio-smoke.md")).text();
    const viteConfig = await Bun.file(resolve(repoRoot, "apps/overdare-ai-agent/sidecar/vite.config.ts")).text();

    expect(sandboxWrapper).toContain("apps\\overdare-ai-agent\\sidecar\\dist\\client");
    expect(guide).toContain("apps/overdare-ai-agent/sidecar/dist/client");
    expect(viteConfig).toContain('outDir: "dist/client"');

    // The setup script must invoke a package script that actually exists; `bun run --cwd`
    // against a missing workspace silently falls back to the root script of the same name.
    expect(freshPcSetup).toContain("overdare-ai-agent:web:build");
    expect(packageJson.scripts["overdare-ai-agent:web:build"]).toContain("apps/overdare-ai-agent/sidecar");
    expect(freshPcSetup).not.toContain("--cwd");

    for (const source of [sandboxWrapper, freshPcSetup, guide]) {
      expect(source).not.toContain("packages/web");
      expect(source).not.toContain("packages\\web");
    }
  });

  // A failed smoke run must never report success. `Start-Process -PassThru` with redirected
  // stdio loses ExitCode unless the handle is pinned, and an empty exit-code.txt casts to 0.
  test("propagate a failing smoke exit code back to the host", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const sandboxWrapper = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/open-windows-sandbox.ps1"),
    ).text();
    const sandboxBootstrap = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/sandbox-bootstrap.ps1"),
    ).text();
    const smokeRunner = await Bun.file(resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/run.ts")).text();

    expect(sandboxBootstrap).toContain("$null = $process.Handle");
    expect(sandboxBootstrap).toContain("$null -eq $runnerProcess.ExitCode");
    expect(sandboxBootstrap).not.toMatch(/\$runnerProcess = Start-Process/);
    expect(sandboxWrapper).toContain("$rawExitCode -notmatch '^-?\\d+$'");
    expect(sandboxWrapper).not.toContain("[int](Get-Content -LiteralPath $exitCodePath -Raw)");
    expect(smokeRunner).toContain("if (failure) throw failure;");
  });
});
