// @summary Test disposable Windows runtime preparation for Studio smoke runs.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStudioFirewallCommands,
  createStudioPrerequisiteCommand,
  createStudioUrlSchemeCommands,
  shouldInstallStudioPrerequisites,
  stageStudioProjectFixture,
  stageStudioRuntimeDependencies,
  suppressInteractiveStudioPrerequisites,
} from "./studio-smoke/windows-runtime";

describe("Studio Windows runtime", () => {
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
});
