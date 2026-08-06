// @summary Test Windows Sandbox, credential, and CI entrypoint wiring for Studio smoke runs.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("Studio smoke entrypoints", () => {
  test("use Windows Sandbox locally and an explicit direct entry in CI", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const packageJson = await Bun.file(resolve(repoRoot, "package.json")).json();
    const workflow = await Bun.file(resolve(repoRoot, ".github/workflows/overdare-studio-smoke.yml")).text();
    const sandboxWrapper = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/open-windows-sandbox.ps1"),
    ).text();
    const sandboxBootstrap = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/sandbox-bootstrap.ps1"),
    ).text();
    const urlSchemeDialogAcceptor = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/accept-studio-url-scheme.ps1"),
    ).text();
    const credentialTool = await Bun.file(
      resolve(repoRoot, "apps/overdare-ai-agent/test/studio-smoke/studio-credential.ps1"),
    ).text();
    const gitignore = await Bun.file(resolve(repoRoot, ".gitignore")).text();

    expect(packageJson.scripts["test:studio-smoke"]).toContain("open-windows-sandbox.ps1");
    expect(packageJson.scripts["test:studio-auth-bootstrap"]).toContain("-AuthBootstrap");
    expect(packageJson.scripts["test:studio-smoke:direct"]).toContain("studio-smoke/run.ts");
    expect(workflow).toContain("bun run test:studio-smoke:direct");
    expect(workflow).toContain("OVERDARE_STUDIO_S3_PREFIX");
    expect(workflow).toContain("OVERDARE_STUDIO_CREDENTIAL_B64");
    expect(workflow).not.toContain("s3 presign");
    expect(sandboxWrapper).toContain("sandbox-env.json");
    expect(sandboxWrapper).toContain("C:\\studio-smoke-bridge\\sandbox-bootstrap.ps1");
    expect(sandboxWrapper).toContain("$bridgeUrlSchemeDialogAcceptor");
    expect(sandboxWrapper).toContain("$bridgeCredentialTool");
    expect(sandboxWrapper).toContain("Get-Command bun.exe -CommandType Application -All");
    expect(sandboxWrapper).toContain("Select-Object -Last 1");
    expect(sandboxWrapper).toContain("<VGpu>Disable</VGpu>");
    expect(sandboxWrapper).toContain("OVERDARE_STUDIO_AUTH_BROWSER_EXE");
    expect(sandboxWrapper).toContain("C:\\studio-smoke-browser");
    expect(sandboxWrapper).toContain('"AWS_SECRET_ACCESS_KEY"');
    expect(sandboxWrapper).toContain("C:\\studio-smoke-cache");
    expect(sandboxWrapper).toContain("OVERDARE_STUDIO_CACHE_DIR");
    expect(sandboxWrapper).toContain("OVERDARE_STUDIO_XINPUT_DLL");
    expect(sandboxWrapper).toContain('Start-Process -FilePath "explorer.exe"');
    expect(sandboxWrapper).toContain(".credential.local");
    expect(sandboxWrapper).toContain("auth-bootstrap");
    expect(sandboxBootstrap).toContain('"OverdareLogintoken"');
    expect(sandboxBootstrap).toContain("Register-AuthBrowser");
    expect(sandboxBootstrap).toContain("HKCU:\\Software\\Classes");
    expect(sandboxBootstrap).toContain("HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64");
    expect(sandboxBootstrap).toContain("studio-credential.ps1");
    expect(sandboxBootstrap).toContain("accept-studio-url-scheme.ps1");
    expect(urlSchemeDialogAcceptor).toContain("Sandbox-Win64-Shipping");
    expect(urlSchemeDialogAcceptor).toContain("Do you want to register custom url scheme?");
    expect(urlSchemeDialogAcceptor).toContain("BM_CLICK");
    expect(urlSchemeDialogAcceptor).toContain("TryActivateOwnedMessageWindow");
    expect(urlSchemeDialogAcceptor).toContain('SendWait("{ENTER}")');
    expect(sandboxBootstrap).toContain("C:\\studio-smoke-bridge\\studio-credential.ps1");
    expect(sandboxBootstrap).toContain('$config.mode -ne "auth-bootstrap" -or $exitCode -eq 0');
    expect(credentialTool).toContain("CredReadW");
    expect(credentialTool).toContain("CredWriteW");
    expect(credentialTool).toContain("OVERDARE_STUDIO_CREDENTIAL_V1");
    expect(gitignore).toContain("**/.env.local");
    expect(gitignore).toContain("**/.credential.local");
  });
});
