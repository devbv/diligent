// @summary Test disposable Windows runtime preparation for Studio smoke runs.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStudioFirewallCommands,
  createStudioUrlSchemeCommands,
  STUDIO_WINDOWS_RUNTIME_FILES,
  stageAppLocalWindowsRuntime,
  stageStudioProjectFixture,
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

  test("allows Studio through the disposable Sandbox firewall before launch", () => {
    const shippingExe = String.raw`C:\run\studio\Sandbox\Binaries\Win64\Sandbox-Win64-Shipping.exe`;
    expect(createStudioFirewallCommands(String.raw`C:\Windows`, String.raw`C:\run\studio`, shippingExe)).toEqual([
      [
        String.raw`C:\Windows\System32\netsh.exe`,
        "advfirewall",
        "firewall",
        "add",
        "rule",
        "name=OVERDARE Studio Smoke 1",
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
        "name=OVERDARE Studio Smoke 2",
        "dir=in",
        "action=allow",
        String.raw`program=C:\run\studio\Sandbox\OverdareAIAgent\overdare-ai-agent.exe`,
        "enable=yes",
        "profile=any",
      ],
    ]);
    expect(
      createStudioFirewallCommands(String.raw`C:\Windows`, String.raw`C:\run\studio`, shippingExe, [
        shippingExe.toUpperCase(),
        String.raw`C:\run\agent.exe`,
        String.raw`C:\run\diligent-web-server.exe`,
      ]).map((command) => command[8]),
    ).toEqual([
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

  test("stages explicit Microsoft runtimes beside only the smoke executables", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-smoke-runtime-test-"));
    try {
      const studioDir = join(root, "studio");
      const runtimeSource = join(root, "windows-runtime");
      const shippingDir = join(studioDir, "Sandbox", "Binaries", "Win64");
      const agentDir = join(root, "agent-runtime");
      await mkdir(runtimeSource, { recursive: true });
      for (const name of STUDIO_WINDOWS_RUNTIME_FILES) {
        await writeFile(join(runtimeSource, name), name);
      }

      await stageAppLocalWindowsRuntime(runtimeSource, [shippingDir, agentDir]);

      expect(await readFile(join(shippingDir, "xinput1_3.dll"), "utf8")).toBe("xinput1_3.dll");
      expect(await readFile(join(shippingDir, "vcruntime140_1.dll"), "utf8")).toBe("vcruntime140_1.dll");
      expect(await readFile(join(agentDir, "vcruntime140.dll"), "utf8")).toBe("vcruntime140.dll");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an incomplete Windows runtime before copying any files", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-smoke-runtime-test-"));
    try {
      const runtimeSource = join(root, "windows-runtime");
      const target = join(root, "target");
      await mkdir(runtimeSource, { recursive: true });
      for (const name of STUDIO_WINDOWS_RUNTIME_FILES.slice(0, -1)) {
        await writeFile(join(runtimeSource, name), name);
      }

      await expect(stageAppLocalWindowsRuntime(runtimeSource, [target])).rejects.toThrow(
        STUDIO_WINDOWS_RUNTIME_FILES.at(-1)!,
      );
      await expect(readFile(join(target, STUDIO_WINDOWS_RUNTIME_FILES[0]), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
