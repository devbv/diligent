// @summary Test the small public contract of the Windows Studio smoke runner.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createIsolatedEnv,
  createSmokeAgentConfig,
  createStudioLaunchArgs,
  createStudioPrerequisiteCommand,
  isLoadedProjectTree,
  readSmokeContract,
  redactStudioDiagnostic,
  shouldInstallStudioPrerequisites,
  stageStudioProjectFixture,
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
    expect(sandboxWrapper).toContain('"AWS_SECRET_ACCESS_KEY"');
    expect(sandboxWrapper).toContain("C:\\studio-smoke-cache");
    expect(sandboxWrapper).toContain("OVERDARE_STUDIO_CACHE_DIR");
    expect(sandboxWrapper).toContain(".credential.local");
    expect(sandboxWrapper).toContain("auth-bootstrap");
    expect(sandboxBootstrap).toContain('"OverdareLogintoken"');
    expect(sandboxBootstrap).toContain("studio-credential.ps1");
    expect(credentialTool).toContain("CredReadW");
    expect(credentialTool).toContain("CredWriteW");
    expect(credentialTool).toContain("OVERDARE_STUDIO_CREDENTIAL_V1");
    expect(gitignore).toContain("**/.env.local");
    expect(gitignore).toContain("**/.credential.local");
  });
});
