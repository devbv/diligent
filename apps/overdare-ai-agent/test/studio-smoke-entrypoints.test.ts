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
    const credentialTool = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/studio-credential.ps1"),
    ).text();
    const gitignore = await Bun.file(resolve(repoRoot, ".gitignore")).text();

    expect(packageJson.scripts["test:studio-smoke"]).toContain("open-windows-sandbox.ps1");
    expect(packageJson.scripts["test:studio-auth-bootstrap"]).toContain("-AuthBootstrap");
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
    expect(credentialTool).toContain("CredReadW");
    expect(credentialTool).toContain("CredWriteW");
    expect(credentialTool).toContain("OVERDARE_STUDIO_CREDENTIAL_V1");
    expect(gitignore).toContain(".env.*");
    expect(gitignore).toContain("**/.credential.local");
  });
});
