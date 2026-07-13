// @summary Tests the agent-done baseline capture and the human-edits diff tool.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";
import { createHumanEditsTool, diffOvdrjmRoots } from "../../src/tools/studiorpc/tools/human-edits-tool";
import type { OvdrjmNode } from "../../src/tools/studiorpc/tools/ovdrjm-utils";
import {
  baselinePath,
  captureBaseline,
  findLatestSnapshot,
  snapshotsDir,
} from "../../src/tools/studiorpc/tools/snapshot";

function projectDir(ovdrjm = '{"Root":{"x":1}}'): string {
  const cwd = mkdtempSync(join(tmpdir(), "proj-"));
  writeFileSync(join(cwd, "world.umap"), "umap");
  writeFileSync(join(cwd, "world.ovdrjm"), ovdrjm);
  return cwd;
}

function toolCtx() {
  return {
    toolCallId: "t",
    signal: new AbortController().signal,
    abort: () => {},
    approve: async () => "once" as const,
  };
}

function stopInput(cwd: string) {
  return {
    session_id: "sess",
    transcript_path: "/tmp/s.jsonl",
    cwd,
    hook_event_name: "Stop",
  };
}

function node(
  type: string,
  guid: string,
  name: string,
  extra: Record<string, unknown> = {},
  children?: unknown[],
): OvdrjmNode {
  return { InstanceType: type, ActorGuid: guid, Name: name, ...extra, ...(children ? { LuaChildren: children } : {}) };
}

async function stopProvider(cwd: string) {
  const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
  const p = provider as typeof provider & { onStop: NonNullable<typeof provider.onStop> };
  await p.onStop(stopInput(cwd));
  return provider;
}

describe("baseline capture on Stop", () => {
  test("copies the current ovdrjm to the fixed baseline and overwrites it each turn", async () => {
    const cwd = projectDir();
    await stopProvider(cwd);
    expect(readFileSync(baselinePath(cwd), "utf-8")).toBe('{"Root":{"x":1}}');

    writeFileSync(join(cwd, "world.ovdrjm"), '{"Root":{"x":2}}');
    await stopProvider(cwd);
    expect(readFileSync(baselinePath(cwd), "utf-8")).toBe('{"Root":{"x":2}}');
  });

  test("does not throw when cwd is not a Studio project", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "empty-"));
    await stopProvider(cwd); // no .umap — capture is best-effort
    expect(existsSync(baselinePath(cwd))).toBe(false);
  });
});

describe("findLatestSnapshot vs baseline", () => {
  test("never picks the baseline even when it is the newest file", () => {
    const cwd = projectDir();
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess_0.ovdrjm"), "snap");
    captureBaseline(cwd);
    utimesSync(join(dir, "sess_0.ovdrjm"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(baselinePath(cwd), new Date(2020, 0, 2), new Date(2020, 0, 2));

    expect(findLatestSnapshot(cwd).id).toBe("sess_0");
  });
});

describe("diffOvdrjmRoots", () => {
  const baseline = node("Workspace", "ws-0", "Workspace", {}, [
    node("Part", "p1", "Floor", { Size: { X: 4, Y: 1, Z: 4 } }),
    node("Model", "m1", "Tree"),
    node("Folder", "f1", "Props"),
    node("PointLight", "l1", "Lamp"),
    node("Script", "s1", "GameLoop", { Source: "local speed = 5\nprint(speed)\n" }),
  ]);

  test("reports added, removed, moved, and modified instances", () => {
    const current = node("Workspace", "ws-0", "Workspace", {}, [
      node("Part", "p1", "Floor", { Size: { X: 12, Y: 1, Z: 4 } }),
      node("Folder", "f1", "Props", {}, [node("Model", "m1", "Tree")]),
      node("Part", "p2", "Ramp"),
      node("Script", "s1", "GameLoop", { Source: "local speed = 5\nprint(speed)\n" }),
    ]);

    const output = diffOvdrjmRoots(baseline, current);
    expect(output).toContain('+ Part "Ramp" (p2) under "Workspace" (ws-0)');
    expect(output).toContain('- PointLight "Lamp" (l1) was under "Workspace" (ws-0)');
    expect(output).toContain('> Model "Tree" (m1): from "Workspace" (ws-0) to "Props" (f1)');
    expect(output).toContain('~ Part "Floor" (p1)');
    expect(output).toContain('Size: {"X":4,"Y":1,"Z":4} -> {"X":12,"Y":1,"Z":4}');
  });

  test("ignores WorldTransform-only changes", () => {
    const before = node("Workspace", "ws-0", "Workspace", {}, [node("Part", "p1", "Floor", { WorldTransform: "a" })]);
    const after = node("Workspace", "ws-0", "Workspace", {}, [node("Part", "p1", "Floor", { WorldTransform: "b" })]);
    expect(diffOvdrjmRoots(before, after)).toBe("No human edits detected since the agent's last completed turn.");
  });

  test("ignores Source differences that are only EOL/indent normalization", () => {
    const before = node("Workspace", "ws-0", "Workspace", {}, [
      node("Script", "s1", "GameLoop", { Source: "if x then\n\tprint(x)\nend\n" }),
    ]);
    const after = node("Workspace", "ws-0", "Workspace", {}, [
      node("Script", "s1", "GameLoop", { Source: "if x then\r\n    print(x)\r\nend\r\n" }),
    ]);
    expect(diffOvdrjmRoots(before, after)).toBe("No human edits detected since the agent's last completed turn.");
  });

  test("reports a real Source change as a compact line diff", () => {
    const current = node("Workspace", "ws-0", "Workspace", {}, [
      node("Part", "p1", "Floor", { Size: { X: 4, Y: 1, Z: 4 } }),
      node("Model", "m1", "Tree"),
      node("Folder", "f1", "Props"),
      node("PointLight", "l1", "Lamp"),
      node("Script", "s1", "GameLoop", { Source: "local speed = 12\nprint(speed)\n" }),
    ]);

    const output = diffOvdrjmRoots(baseline, current);
    expect(output).toContain('* Script "GameLoop" (s1) lines 1-1:');
    expect(output).toContain("  - local speed = 5");
    expect(output).toContain("  + local speed = 12");
  });

  test("caps long Source diffs", () => {
    const oldSource = Array.from({ length: 60 }, (_, i) => `old ${i}`).join("\n");
    const newSource = Array.from({ length: 60 }, (_, i) => `new ${i}`).join("\n");
    const before = node("Workspace", "ws-0", "Workspace", {}, [node("Script", "s1", "S", { Source: oldSource })]);
    const after = node("Workspace", "ws-0", "Workspace", {}, [node("Script", "s1", "S", { Source: newSource })]);

    const output = diffOvdrjmRoots(before, after);
    expect(output).toContain("(… 40 more lines)");
    expect(output).not.toContain("old 25");
  });

  test("skips nodes without an ActorGuid but still walks their children", () => {
    const before = node("Workspace", "ws-0", "Workspace", {}, [
      { InstanceType: "Folder", Name: "NoGuid", LuaChildren: [node("Part", "p1", "Floor")] },
    ]);
    const after = node("Workspace", "ws-0", "Workspace", {}, [
      { InstanceType: "Folder", Name: "NoGuid", LuaChildren: [node("Part", "p1", "Floor", { Anchored: true })] },
    ]);

    const output = diffOvdrjmRoots(before, after);
    expect(output).toContain('~ Part "Floor" (p1)');
    expect(output).toContain("Anchored: (none) -> true");
  });
});

describe("createHumanEditsTool", () => {
  test("returns a friendly message when no baseline exists", async () => {
    const cwd = projectDir();
    const result = await createHumanEditsTool(cwd).execute({} as never, toolCtx());
    expect(result.output).toContain("No baseline snapshot exists yet");
    expect(result.metadata?.error).toBeUndefined();
    expect(result.metadata?.noBaseline).toBe(true);
  });

  test("diffs the baseline against the current file", async () => {
    const cwd = projectDir(
      JSON.stringify({ Root: node("Workspace", "ws-0", "Workspace", {}, [node("Part", "p1", "Floor")]) }),
    );
    captureBaseline(cwd);
    writeFileSync(
      join(cwd, "world.ovdrjm"),
      JSON.stringify({
        Root: node("Workspace", "ws-0", "Workspace", {}, [node("Part", "p1", "Floor"), node("Part", "p2", "Ramp")]),
      }),
    );

    const result = await createHumanEditsTool(cwd).execute({} as never, toolCtx());
    expect(result.output).toContain('+ Part "Ramp" (p2)');
    expect(result.metadata?.error).toBeUndefined();
  });

  test("reads a UTF-16LE baseline", async () => {
    const cwd = projectDir(
      JSON.stringify({ Root: node("Workspace", "ws-0", "Workspace", {}, [node("Part", "p2", "Ramp")]) }),
    );
    const baselineJson = JSON.stringify({ Root: node("Workspace", "ws-0", "Workspace") });
    mkdirSync(snapshotsDir(cwd), { recursive: true });
    writeFileSync(baselinePath(cwd), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(baselineJson, "utf16le")]));

    const result = await createHumanEditsTool(cwd).execute({} as never, toolCtx());
    expect(result.output).toContain('+ Part "Ramp" (p2)');
  });

  test("is registered as a tool on the provider", async () => {
    const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
    const tools = await provider.createTools({
      cwd: "/tmp/project",
      host: { approve: async () => "once" },
    });
    expect(tools.map((tool) => tool.name)).toContain("studiorpc_human_edits");
  });
});

describe("turn-start diff cache", () => {
  test("a late tool call does not misattribute agent edits made after the prompt", async () => {
    const cwd = projectDir(
      JSON.stringify({ Root: node("Workspace", "ws-0", "Workspace", {}, [node("Part", "p1", "Floor")]) }),
    );
    const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
    const p = provider as typeof provider & {
      onStop: NonNullable<typeof provider.onStop>;
      onUserPromptSubmit: NonNullable<typeof provider.onUserPromptSubmit>;
    };

    // Turn N ends: baseline captured.
    await p.onStop(stopInput(cwd));

    // Human adds Ramp in Studio (flushed to file), then submits a prompt.
    writeFileSync(
      join(cwd, "world.ovdrjm"),
      JSON.stringify({
        Root: node("Workspace", "ws-0", "Workspace", {}, [node("Part", "p1", "Floor"), node("Part", "p2", "Ramp")]),
      }),
    );
    await p.onUserPromptSubmit({ ...stopInput(cwd), hook_event_name: "UserPromptSubmit" });

    // Agent edits the map BEFORE calling the human-edits tool.
    writeFileSync(
      join(cwd, "world.ovdrjm"),
      JSON.stringify({
        Root: node("Workspace", "ws-0", "Workspace", {}, [
          node("Part", "p1", "Floor"),
          node("Part", "p2", "Ramp"),
          node("Part", "p3", "AgentPart"),
        ]),
      }),
    );

    const tools = await provider.createTools({ cwd, host: { approve: async () => "once" } });
    const tool = tools.find((t) => t.name === "studiorpc_human_edits")!;
    const result = await tool.execute({} as never, toolCtx());

    expect(result.output).toContain('+ Part "Ramp" (p2)'); // human edit reported
    expect(result.output).not.toContain("AgentPart"); // agent edit excluded
  });
});
