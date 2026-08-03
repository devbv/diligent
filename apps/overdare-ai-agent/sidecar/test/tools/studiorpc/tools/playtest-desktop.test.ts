// @summary Tests PowerShell desktop adapter payload safety, failure handling, and abort behavior.

import { describe, expect, test } from "bun:test";
import {
  createPowerShellRunner,
  createWindowsDesktopAdapter,
  type PowerShellChild,
  type PowerShellSpawn,
} from "../../../../src/tools/studiorpc/tools/playtest-desktop";

function stream(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

function child(options: { stdout?: string; stderr?: string; exitCode?: number; exited?: Promise<number> } = {}): {
  value: PowerShellChild;
  killed: () => boolean;
} {
  let wasKilled = false;
  return {
    value: {
      stdout: stream(options.stdout ?? ""),
      stderr: stream(options.stderr ?? ""),
      exited: options.exited ?? Promise.resolve(options.exitCode ?? 0),
      kill: () => {
        wasKilled = true;
      },
    },
    killed: () => wasKilled,
  };
}

describe("PowerShell playtest runner", () => {
  test("passes the payload through a base64 environment variable and keeps it out of argv", async () => {
    let command: string[] = [];
    let environment: Record<string, string | undefined> = {};
    const spawned = child({ stdout: '{"ok":true}' });
    const spawn: PowerShellSpawn = (argv, options) => {
      command = argv;
      environment = options.env;
      return spawned.value;
    };
    const runner = createPowerShellRunner({ spawn, timeoutMs: 1_000 });
    const payload = { operation: "list", match: "overdare'; Write-Host injected" } as const;

    await runner(payload, new AbortController().signal);

    expect(command[0]).toBe("powershell.exe");
    expect(command).toContain("-EncodedCommand");
    expect(command.join(" ")).not.toContain(payload.match);
    expect(JSON.parse(Buffer.from(environment.OVERDARE_PLAYTEST_PAYLOAD!, "base64").toString("utf8"))).toEqual(payload);
    const encodedScript = command.at(-1)!;
    const decodedScript = Buffer.from(encodedScript, "base64").toString("utf16le");
    expect(decodedScript).toContain("SendInput");
    expect(decodedScript).toContain('"W" { return [System.UInt16]0x57 }');
    expect(decodedScript).not.toContain("return [ushort]");
  });

  test("surfaces non-zero exit, timeout, and pre-aborted execution", async () => {
    const failed = child({ stderr: "native failure", exitCode: 7 });
    const failedRunner = createPowerShellRunner({ spawn: () => failed.value, timeoutMs: 1_000 });
    expect(failedRunner({ operation: "list", match: "overdare" }, new AbortController().signal)).rejects.toThrow(
      "native failure",
    );

    const hanging = child({ exited: new Promise<number>(() => {}) });
    const timeoutRunner = createPowerShellRunner({ spawn: () => hanging.value, timeoutMs: 5 });
    expect(timeoutRunner({ operation: "list", match: "overdare" }, new AbortController().signal)).rejects.toThrow(
      "timed out",
    );
    await Bun.sleep(10);
    expect(hanging.killed()).toBe(true);

    const interrupted = child({ exited: new Promise<number>(() => {}) });
    const interruptRunner = createPowerShellRunner({ spawn: () => interrupted.value, timeoutMs: 1_000 });
    const midRunController = new AbortController();
    const interruptedResult = interruptRunner({ operation: "list", match: "overdare" }, midRunController.signal);
    midRunController.abort();
    expect(interruptedResult).rejects.toThrow("interrupted");
    expect(interrupted.killed()).toBe(true);

    const controller = new AbortController();
    controller.abort();
    let spawnCalls = 0;
    const abortedRunner = createPowerShellRunner({
      spawn: () => {
        spawnCalls++;
        return child().value;
      },
    });
    expect(abortedRunner({ operation: "list", match: "overdare" }, controller.signal)).rejects.toThrow("interrupted");
    expect(spawnCalls).toBe(0);
  });
});

describe("Windows playtest desktop adapter", () => {
  test("normalizes listed windows and revalidates capture and input payloads", async () => {
    const payloads: unknown[] = [];
    const adapter = createWindowsDesktopAdapter({
      runner: async (payload) => {
        payloads.push(payload);
        if (payload.operation === "list") {
          return [
            { id: "20", title: "OVERDARE Studio", processName: "OVERDAREStudio" },
            { id: 21, title: "", processName: "ignored" },
          ];
        }
        return { ok: true };
      },
    });
    const signal = new AbortController().signal;

    expect(await adapter.listWindows("overdare", signal)).toEqual([
      { id: "20", title: "OVERDARE Studio", processName: "OVERDAREStudio" },
    ]);
    await adapter.capture({
      windowId: "20",
      match: "overdare",
      outputPath: "C:\\playtest\\before.png",
      signal,
    });
    await adapter.applyActions({
      windowId: "20",
      match: "overdare",
      actions: [
        { type: "click_center" },
        { type: "set_keys", keys: ["W"], durationMs: 400 },
        { type: "set_keys", keys: ["W", "SPACE"], durationMs: 100 },
        { type: "set_keys", keys: ["D"], durationMs: 300 },
        { type: "set_keys", keys: [], durationMs: 200 },
      ],
      signal,
    });

    expect(payloads).toEqual([
      { operation: "list", match: "overdare" },
      {
        operation: "capture",
        match: "overdare",
        windowId: "20",
        outputPath: "C:\\playtest\\before.png",
      },
      {
        operation: "input",
        match: "overdare",
        windowId: "20",
        actions: [
          { type: "click_center" },
          { type: "set_keys", keys: ["W"], durationMs: 400 },
          { type: "set_keys", keys: ["W", "SPACE"], durationMs: 100 },
          { type: "set_keys", keys: ["D"], durationMs: 300 },
          { type: "set_keys", keys: [], durationMs: 200 },
        ],
      },
    ]);
  });

  test("rejects unsafe or overlong action timelines before invoking PowerShell", async () => {
    let calls = 0;
    const adapter = createWindowsDesktopAdapter({
      runner: async () => {
        calls++;
        return { ok: true };
      },
    });
    const signal = new AbortController().signal;
    const base = { windowId: "20", match: "overdare", signal };

    await expect(
      adapter.applyActions({
        ...base,
        actions: [{ type: "set_keys", keys: ["W"], durationMs: 100 }],
      }),
    ).rejects.toThrow("click_center");
    await expect(
      adapter.applyActions({
        ...base,
        actions: [{ type: "click_center" }, { type: "set_keys", keys: ["W", "W"], durationMs: 100 }],
      }),
    ).rejects.toThrow("unique");
    await expect(
      adapter.applyActions({
        ...base,
        actions: [
          { type: "click_center" },
          { type: "set_keys", keys: ["W"], durationMs: 1_500 },
          { type: "set_keys", keys: ["D"], durationMs: 1_500 },
          { type: "set_keys", keys: ["A"], durationMs: 1_500 },
          { type: "set_keys", keys: ["S"], durationMs: 1_500 },
        ],
      }),
    ).rejects.toThrow("5,000");
    expect(calls).toBe(0);
  });
});
