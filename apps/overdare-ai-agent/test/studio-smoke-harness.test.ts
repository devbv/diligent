// @summary Test the small public contract of the Windows Studio smoke runner.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createIsolatedEnv,
  createSmokeAgentConfig,
  createStudioFirewallCommands,
  createStudioLaunchArgs,
  createStudioPrerequisiteCommand,
  createStudioUrlSchemeCommands,
  isLoadedProjectTree,
  readSmokeContract,
  redactStudioDiagnostic,
  STUDIO_DOWNLOAD_TIMEOUT_MS,
  shouldInstallStudioPrerequisites,
  stageStudioProjectFixture,
  stageStudioRuntimeDependencies,
  suppressInteractiveStudioPrerequisites,
  withStageTimeout,
} from "./studio-smoke/run";

const VALID_ENV: NodeJS.ProcessEnv = {
  OVERDARE_STUDIO_URL: "https://s3.example.test/studio.zip?signature=short-lived",
  OVERDARE_STUDIO_SHA256: "a".repeat(64),
  OVERDARE_STUDIO_EXE_RELATIVE_PATH: String.raw`Studio\OVERDAREStudio.exe`,
  OVERDARE_STUDIO_ARGS_JSON: JSON.stringify(["--log-dir={logDir}"]),
};

const VALID_S3_ENV: NodeJS.ProcessEnv = {
  OVERDARE_STUDIO_S3_BUCKET: "ovdr-build-binary",
  OVERDARE_STUDIO_S3_REGION: "ap-northeast-2",
  OVERDARE_STUDIO_S3_PREFIX: "Sandbox/Windows/",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  OVERDARE_STUDIO_EXE_RELATIVE_PATH: "Sandbox.exe",
  OVERDARE_STUDIO_ARGS_JSON: VALID_ENV.OVERDARE_STUDIO_ARGS_JSON,
};

describe("Studio smoke runner", () => {
  test("allows large Studio archives up to thirty minutes to download", () => {
    expect(STUDIO_DOWNLOAD_TIMEOUT_MS).toBe(30 * 60_000);
  });

  test("validates the explicit Studio launch contract", () => {
    const contract = readSmokeContract(VALID_ENV);
    expect(contract.source.kind).toBe("url");
    expect(contract.studioSha256).toBe("a".repeat(64));
    expect(contract.studioRpcPort).toBe(13377);
    const privateUrlContract = readSmokeContract({
      ...VALID_ENV,
      OVERDARE_STUDIO_URL: "http://10.31.55.107:9000/bucket/studio.zip?signature=short-lived",
    });
    expect(privateUrlContract.source.kind === "url" ? privateUrlContract.source.url : "").toStartWith(
      "http://10.31.55.107:9000/",
    );
    expect(() =>
      readSmokeContract({
        ...VALID_ENV,
        OVERDARE_STUDIO_URL: "http://downloads.example.test/studio.zip",
      }),
    ).toThrow("HTTPS or use a private IPv4");
    expect(
      readSmokeContract({
        ...VALID_ENV,
        OVERDARE_STUDIO_ARGS_JSON: "[]",
      }).studioArgs,
    ).toEqual([]);
    expect(() =>
      readSmokeContract({
        ...VALID_ENV,
        OVERDARE_STUDIO_ARGS_JSON: JSON.stringify({ project: "{projectDir}" }),
      }),
    ).toThrow("JSON array");
    expect(() =>
      readSmokeContract({
        ...VALID_ENV,
        OVERDARE_STUDIO_RPC_PORT: "not-a-port",
      }),
    ).toThrow("OVERDARE_STUDIO_RPC_PORT");
  });

  test("accepts an AWS S3 source with temporary credentials", () => {
    const contract = readSmokeContract({
      ...VALID_S3_ENV,
      AWS_SESSION_TOKEN: "temporary-session-token",
    });

    expect(contract.source).toEqual({
      kind: "s3",
      bucket: "ovdr-build-binary",
      region: "ap-northeast-2",
      prefix: "Sandbox/Windows/",
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        sessionToken: "temporary-session-token",
      },
    });
    expect(contract.studioSha256).toBeUndefined();
  });

  test("requires complete AWS credentials for an S3 source", () => {
    expect(() =>
      readSmokeContract({
        ...VALID_S3_ENV,
        AWS_SECRET_ACCESS_KEY: undefined,
      }),
    ).toThrow("AWS_SECRET_ACCESS_KEY");
  });

  test("always opens the staged Studio map before applying extra arguments", () => {
    expect(
      createStudioLaunchArgs(JSON.parse(VALID_ENV.OVERDARE_STUDIO_ARGS_JSON!), {
        projectDir: String.raw`C:\run\project`,
        projectMap: String.raw`C:\run\project\project.umap`,
        rpcPort: 43123,
        logDir: String.raw`C:\run\logs`,
        userDataDir: String.raw`C:\run\user-data`,
      }),
    ).toEqual([
      String.raw`-OpenMap=C:\run\project\project.umap`,
      String.raw`-ABSLOG=C:\run\user-data\studio.log`,
      String.raw`--log-dir=C:\run\logs`,
    ]);
  });

  test("stages the bundled Baseplate as a disposable project fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-smoke-fixture-test-"));
    try {
      const studioDir = join(root, "studio");
      const projectDir = join(root, "project");
      const templateDir = join(studioDir, "Sandbox", "EditorResource", "Sandbox", "WorldTemplate", "Baseplate");
      await mkdir(templateDir, { recursive: true });
      await writeFile(join(templateDir, "Baseplate.umap"), "map fixture");
      await writeFile(join(templateDir, "Baseplate.ovdrm"), "metadata fixture");

      const fixture = await stageStudioProjectFixture(studioDir, projectDir);

      expect(fixture.mapPath).toBe(join(projectDir, "project.umap"));
      expect(await readFile(fixture.mapPath, "utf8")).toBe("map fixture");
      expect(await readFile(join(projectDir, "Baseplate.ovdrm"), "utf8")).toBe("metadata fixture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces PATH and user state without forwarding credentials", () => {
    const env = createIsolatedEnv(
      {
        SystemRoot: String.raw`C:\Windows`,
        PATH: String.raw`C:\Users\developer\bin`,
        AWS_SECRET_ACCESS_KEY: "must-not-leak",
      },
      {
        home: String.raw`C:\run\user`,
        appData: String.raw`C:\run\user\AppData\Roaming`,
        localAppData: String.raw`C:\run\user\AppData\Local`,
        temp: String.raw`C:\run\temp`,
      },
      String.raw`C:\run\studio\Studio.exe`,
    );
    expect(env.PATH).toBe(String.raw`C:\run\studio;C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0`);
    expect(env.USERPROFILE).toBe(String.raw`C:\run\user`);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  test("requires a non-empty project tree and labels timeouts", async () => {
    expect(isLoadedProjectTree({ level: [{ guid: "root" }] })).toBe(true);
    expect(isLoadedProjectTree({ level: [] })).toBe(false);
    await expect(
      withStageTimeout("project-ready", 5, async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }),
    ).rejects.toThrow("[project-ready] timed out");
  });

  test("redacts Studio authentication material before preserving diagnostics", () => {
    expect(
      redactStudioDiagnostic(
        '-AUTH_PASSWORD=exchange-code {"token":"secret"} eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
      ),
    ).toBe('-AUTH_PASSWORD=[REDACTED] {"token":"[REDACTED]"} [REDACTED_JWT]');
  });

  test("runs the bundled Unreal prerequisite installer silently", () => {
    expect(createStudioPrerequisiteCommand(String.raw`C:\run\studio`, String.raw`C:\run\logs`)).toEqual([
      String.raw`C:\run\studio\Engine\Extras\Redist\en-us\UEPrereqSetup_x64.exe`,
      "/quiet",
      "/norestart",
      "/log",
      String.raw`C:\run\logs\ue-prerequisites.log`,
    ]);
    expect(shouldInstallStudioPrerequisites(-1073741515)).toBe(true);
    expect(shouldInstallStudioPrerequisites(0xc0000135)).toBe(true);
    expect(shouldInstallStudioPrerequisites(1)).toBe(false);
  });

  test("allows Studio through the disposable Sandbox firewall before launch", () => {
    expect(
      createStudioFirewallCommands(
        String.raw`C:\Windows`,
        String.raw`C:\run\studio`,
        String.raw`C:\run\studio\Sandbox.exe`,
      ),
    ).toEqual([
      [
        String.raw`C:\Windows\System32\netsh.exe`,
        "advfirewall",
        "firewall",
        "add",
        "rule",
        "name=OVERDARE Studio Smoke 1",
        "dir=in",
        "action=allow",
        String.raw`program=C:\run\studio\Sandbox.exe`,
        "enable=yes",
        "profile=any",
      ],
      [
        String.raw`C:\Windows\System32\netsh.exe`,
        "advfirewall",
        "firewall",
        "add",
        "rule",
        "name=OVERDARE Studio Smoke 2",
        "dir=in",
        "action=allow",
        String.raw`program=C:\run\studio\Sandbox\Binaries\Win64\Sandbox-Win64-Shipping.exe`,
        "enable=yes",
        "profile=any",
      ],
      [
        String.raw`C:\Windows\System32\netsh.exe`,
        "advfirewall",
        "firewall",
        "add",
        "rule",
        "name=OVERDARE Studio Smoke 3",
        "dir=in",
        "action=allow",
        String.raw`program=C:\run\studio\Sandbox\OverdareAIAgent\overdare-ai-agent.exe`,
        "enable=yes",
        "profile=any",
      ],
    ]);
    expect(
      createStudioFirewallCommands(
        String.raw`C:\Windows`,
        String.raw`C:\run\studio`,
        String.raw`C:\run\studio\Sandbox.exe`,
        [String.raw`C:\run\agent.exe`, String.raw`C:\run\diligent-web-server.exe`],
      ).map((command) => command[8]),
    ).toEqual([
      String.raw`program=C:\run\studio\Sandbox.exe`,
      String.raw`program=C:\run\studio\Sandbox\Binaries\Win64\Sandbox-Win64-Shipping.exe`,
      String.raw`program=C:\run\studio\Sandbox\OverdareAIAgent\overdare-ai-agent.exe`,
      String.raw`program=C:\run\agent.exe`,
      String.raw`program=C:\run\diligent-web-server.exe`,
    ]);
  });

  test("registers the Studio login callback scheme without an interactive prompt", () => {
    expect(
      createStudioUrlSchemeCommands(
        String.raw`C:\Windows`,
        String.raw`C:\run\studio\Sandbox\Binaries\Win64\Sandbox-Win64-Shipping.exe`,
      ),
    ).toEqual([
      [
        String.raw`C:\Windows\System32\reg.exe`,
        "add",
        String.raw`HKCR\ovdrstudio`,
        "/v",
        "URL protocol",
        "/d",
        "",
        "/f",
      ],
      [
        String.raw`C:\Windows\System32\reg.exe`,
        "add",
        String.raw`HKCR\ovdrstudio\shell\open\command`,
        "/ve",
        "/d",
        String.raw`"C:\run\studio\Sandbox\Binaries\Win64\Sandbox-Win64-Shipping.exe" "%1"`,
        "/f",
      ],
    ]);
  });

  test("suppresses the aggregate UE prerequisite installer during normal startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-smoke-prerequisite-test-"));
    try {
      const studioDir = join(root, "studio");
      const redistDir = join(studioDir, "Engine", "Extras", "Redist", "en-us");
      await mkdir(redistDir, { recursive: true });
      const installer = join(redistDir, "UEPrereqSetup_x64.exe");
      const stub = join(root, "prerequisite-stub.exe");
      await writeFile(installer, "installer fixture");
      await writeFile(stub, "stub fixture");

      const suppressed = await suppressInteractiveStudioPrerequisites(studioDir, stub);

      expect(suppressed).toEqual({
        installer,
        suppressedInstaller: `${installer}.studio-smoke-disabled`,
      });
      expect(await readFile(installer, "utf8")).toBe("stub fixture");
      expect(await readFile(`${installer}.studio-smoke-disabled`, "utf8")).toBe("installer fixture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stages the bundled VC runtime and mapped XInput beside Studio binaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-smoke-runtime-test-"));
    try {
      const studioDir = join(root, "studio");
      const runtimeSource = join(
        studioDir,
        "Engine",
        "Plugins",
        "LuaMachine",
        "Source",
        "ThirdParty",
        "lua-language-server",
        "bin",
      );
      const shippingDir = join(studioDir, "Sandbox", "Binaries", "Win64");
      const agentDir = join(root, "agent-runtime");
      const xinput = join(root, "xinput1_3.dll");
      await Promise.all([mkdir(runtimeSource, { recursive: true }), mkdir(shippingDir, { recursive: true })]);
      for (const name of [
        "msvcp140.dll",
        "msvcp140_1.dll",
        "msvcp140_2.dll",
        "msvcp140_atomic_wait.dll",
        "msvcp140_codecvt_ids.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
      ]) {
        await writeFile(join(runtimeSource, name), name);
      }
      await writeFile(xinput, "xinput fixture");

      await stageStudioRuntimeDependencies(studioDir, xinput, [agentDir]);

      expect(await readFile(join(studioDir, "xinput1_3.dll"), "utf8")).toBe("xinput fixture");
      expect(await readFile(join(shippingDir, "xinput1_3.dll"), "utf8")).toBe("xinput fixture");
      expect(await readFile(join(shippingDir, "vcruntime140_1.dll"), "utf8")).toBe("vcruntime140_1.dll");
      expect(await readFile(join(agentDir, "vcruntime140.dll"), "utf8")).toBe("vcruntime140.dll");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("disables agent runtime updates inside the disposable profile", () => {
    expect(JSON.parse(createSmokeAgentConfig())).toEqual({ updateMode: "disabled" });
  });

  test("uses Windows Sandbox by default and an explicit direct entry in CI", async () => {
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
