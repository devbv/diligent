// @summary Tests EditLogging consumption, summarization, and human-edits context injection.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";
import { editLoggingDir, rotateAndReadEditLogs, summarizeEditLog } from "../../src/tools/studiorpc/tools/edit-log";
import { consumeHumanEdits, createHumanEditsTool } from "../../src/tools/studiorpc/tools/human-edits-tool";

const NO_EDITS = "No human edits detected since the agent's last completed turn.";

function projectDir(): string {
  const cwd = mkdtempSync(join(tmpdir(), "proj-"));
  writeFileSync(join(cwd, "world.umap"), "umap");
  writeFileSync(join(cwd, "world.ovdrjm"), '{"Root":{}}');
  return cwd;
}

function writeEditLog(cwd: string, envelopes: unknown[], file = "EditLog.json"): void {
  const dir = editLoggingDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), envelopes.map((envelope) => JSON.stringify(envelope)).join("\n"));
}

function envelope(
  operation: string,
  objects: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { timestamp: "2026-08-27T00:00:00.000Z", transactionId: "tx", operation, objects, ...extra };
}

function subject(
  type: string,
  guid: string,
  name: string,
  action: string,
  changes: unknown[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { InstanceType: type, ActorGuid: guid, Name: name, action, role: "subject", changes, ...extra };
}

function toolCtx() {
  return {
    toolCallId: "t",
    signal: new AbortController().signal,
    abort: () => {},
    approve: async () => "once" as const,
  };
}

function promptInput(cwd: string) {
  return {
    session_id: "sess",
    transcript_path: "/tmp/s.jsonl",
    cwd,
    hook_event_name: "UserPromptSubmit",
    prompt: "hello",
  };
}

describe("summarizeEditLog", () => {
  test("reports created, removed, moved, and modified instances by section", () => {
    const envelopes = [
      envelope("Create", [subject("Part", "p2", "Ramp", "Create")]),
      envelope("Delete", [subject("PointLight", "l1", "Lamp", "Delete")]),
      envelope("Reparent", [
        subject("Model", "m1", "Tree", "Reparent", [{ property: "Parent", before: "Workspace", after: "Props" }]),
        {
          InstanceType: "Folder",
          ActorGuid: "f1",
          Name: "Props",
          role: "auxiliary",
          action: "SetProperty",
          changes: [],
        },
      ]),
      envelope("SetProperty", [
        subject("Part", "p1", "Floor", "SetProperty", [{ property: "Size", before: "(4,1,4)", after: "(12,1,4)" }]),
      ]),
    ];

    const { output, editCount } = summarizeEditLog(envelopes.map(parse));
    expect(editCount).toBe(4);
    expect(output).toContain('Added (1):\n+ Part "Ramp" (p2)');
    expect(output).toContain('Removed (1):\n- PointLight "Lamp" (l1)');
    expect(output).toContain('> Model "Tree" (m1): parent Workspace -> Props');
    expect(output).toContain('~ Part "Floor" (p1)');
    expect(output).toContain("  Size: (4,1,4) -> (12,1,4)");
    expect(output).not.toContain('"Props" (f1)'); // auxiliary records carry no human intent
  });

  test("collapses repeated edits of the same property to first-before -> last-after", () => {
    const envelopes = [
      envelope("SetProperty", [
        subject("Part", "p1", "Door", "SetProperty", [{ property: "CFrame", before: "A", after: "B" }]),
      ]),
      envelope("SetProperty", [
        subject("Part", "p1", "Door", "SetProperty", [{ property: "CFrame", before: "B", after: "C" }]),
      ]),
    ];

    const { output } = summarizeEditLog(envelopes.map(parse));
    expect(output).toContain("  CFrame: A -> C (2 edits)");
    expect(output).not.toContain("A -> B");
  });

  test("folds an instance that was added and then removed into its own section", () => {
    const envelopes = [
      envelope("Create", [subject("Tool", "w1", "Weapon", "Create")]),
      envelope("Delete", [subject("Tool", "w1", "Weapon", "Delete")]),
    ];

    const { output } = summarizeEditLog(envelopes.map(parse));
    expect(output).toContain('Added then removed (1):\n± Tool "Weapon" (w1)');
    expect(output).not.toContain("Added (1)");
    expect(output).not.toContain("Removed (1)");
  });

  test("renders list deltas (added/removed) and modified struct elements", () => {
    const envelopes = [
      envelope("SetProperty", [
        subject("Workspace", "ws-0", "Workspace", "SetProperty", [
          { property: "Tag", added: ["Enemy", "Interactable"] },
          {
            property: "LuaChildren",
            added: [{ Name: "LuaSpawnLocation", InstanceType: "SpawnLocation", ObjectGuid: "sp1" }],
          },
          {
            property: "Attribute",
            modified: [
              {
                before: { Key: "TestColor", DataType: "Color3", Value: { R: 254, G: 254, B: 254 } },
                after: { Key: "TestColor", DataType: "Color3", Value: { R: 254, G: 0, B: 0 } },
              },
            ],
          },
        ]),
      ]),
    ];

    const { output } = summarizeEditLog(envelopes.map(parse));
    expect(output).toContain("  Tag: added Enemy, Interactable");
    expect(output).toContain('  LuaChildren: added SpawnLocation "LuaSpawnLocation"');
    expect(output).toContain('  Attribute: modified "TestColor":');
  });

  test("reports script Source changes as events without content", () => {
    const envelopes = [
      envelope("SetProperty", [subject("Script", "s1", "GameLoop", "SetProperty", [{ property: "Source" }])]),
    ];

    const { output } = summarizeEditLog(envelopes.map(parse));
    expect(output).toContain('* Script "GameLoop" (s1): source edited 1 time(s)');
    expect(output).toContain("content is not logged");
  });

  test("falls back to subjectGuids when records carry no role", () => {
    const envelopes = [
      envelope(
        "Create",
        [
          { InstanceType: "Camera", ObjectGuid: "c1", Name: "Camera", changes: [] },
          { InstanceType: "Workspace", ObjectGuid: "ws-0", Name: "Workspace", changes: [] },
        ],
        { ObjectGuids: ["c1"] },
      ),
    ];

    const { output } = summarizeEditLog(envelopes.map(parse));
    expect(output).toContain('+ Camera "Camera" (c1)');
    expect(output).not.toContain("Workspace");
  });

  test("returns the no-edits message for an empty batch", () => {
    expect(summarizeEditLog([]).output).toBe(NO_EDITS);
  });
});

/** Round-trip a raw envelope through the real file parser so tests exercise it too. */
function parse(raw: Record<string, unknown>) {
  const cwd = projectDir();
  writeEditLog(cwd, [raw]);
  const batch = rotateAndReadEditLogs(cwd);
  if (batch.envelopes.length !== 1) throw new Error("test envelope failed to parse");
  return batch.envelopes[0];
}

describe("real Studio Edit.Log format", () => {
  // Verbatim shape observed from Studio 2026-08: single `Edit.Log` in the
  // project root, CRLF, PascalCase fields, pretty-printed objects concatenated
  // back to back (not JSONL, not an array), subjects via envelope ActorGuids.
  const REAL_LOG = [
    JSON.stringify(
      {
        Timestamp: "2026-08-26T12:14:59.968Z",
        TransactionId: "7C20523D489A46F9D55A4384881357DD",
        Action: "Create",
        ActorGuids: ["00A01E0A47D96274567636A74BCA5513"],
        ParentGuid: "AC1F33D84F36064BB118299C2D2AA77E",
        Objects: [
          { InstanceType: "PointLight", ActorGuid: "BD2B5821", Name: "PointLight" },
          { InstanceType: "Model", ActorGuid: "00A01E0A47D96274567636A74BCA5513", Name: "Campfire" },
          {
            InstanceType: "Workspace",
            ActorGuid: "AC1F33D84F36064BB118299C2D2AA77E",
            Name: "Workspace",
            Changes: [
              {
                Property: "LuaChildren",
                Added: [{ InstanceType: "Model", Name: "Campfire", ActorGuid: "00A01E0A47D96274567636A74BCA5513" }],
              },
            ],
          },
        ],
      },
      null,
      "\t",
    ),
    JSON.stringify(
      {
        Timestamp: "2026-08-26T12:17:15.940Z",
        TransactionId: "BC860CAF41C11CC996D06CB3A3660E99",
        Action: "SetProperty",
        ActorGuids: ["3DB92227FA6C6CAE98C3BEB1766F8599"],
        Objects: [
          {
            InstanceType: "LocalScript",
            ActorGuid: "3DB92227FA6C6CAE98C3BEB1766F8599",
            Name: "WASDController",
            Changes: [{ Property: "Source", Changed: true }],
          },
        ],
      },
      null,
      "\t",
    ),
  ]
    .join("\n")
    .replace(/\n/g, "\r\n");

  test("consumes a root Edit.Log with PascalCase concatenated envelopes", () => {
    const cwd = projectDir();
    writeFileSync(join(cwd, "Edit.Log"), REAL_LOG);

    const capture = consumeHumanEdits(cwd);
    expect(capture.result.metadata?.humanEditsDetected).toBe(true);
    expect(capture.result.metadata?.transactions).toBe(2);
    // Only the envelope subject (ActorGuids) counts; auxiliary creations and
    // the Workspace LuaChildren fallout are not the human's direct intent.
    expect(capture.result.output).toContain('+ Model "Campfire" (00A01E0A47D96274567636A74BCA5513)');
    expect(capture.result.output).not.toContain("PointLight");
    expect(capture.result.output).not.toContain("Workspace");
    expect(capture.result.output).toContain('* LocalScript "WASDController"');

    // Rotation happens at the root, and finalize clears it.
    const rootNames = readdirSync(cwd);
    expect(rootNames).not.toContain("Edit.Log");
    expect(rootNames.some((name) => name.endsWith(".consuming"))).toBe(true);
    capture.finalize();
    expect(readdirSync(cwd).some((name) => name.endsWith(".consuming"))).toBe(false);
  });

  test("ignores unrelated root files and a truncated trailing envelope", () => {
    const cwd = projectDir();
    writeFileSync(join(cwd, "Play.log"), "not an edit log");
    writeFileSync(join(cwd, "Edit.Log"), `${REAL_LOG}\r\n{\r\n\t"Timestamp": "2026-08-26T12:`);

    const { result } = consumeHumanEdits(cwd);
    expect(result.metadata?.humanEditsDetected).toBe(true);
    expect(result.metadata?.transactions).toBe(2); // truncated tail dropped, not fatal
    expect(readdirSync(cwd)).toContain("Play.log"); // untouched
  });
});

describe("consumeHumanEdits", () => {
  test("returns no-edits when the EditLogging directory does not exist", () => {
    const { result } = consumeHumanEdits(projectDir());
    expect(result.output).toBe(NO_EDITS);
    expect(result.metadata?.humanEditsDetected).toBe(false);
  });

  test("rotates log files immediately and deletes them only on finalize", () => {
    const cwd = projectDir();
    writeEditLog(cwd, [envelope("Create", [subject("Part", "p2", "Ramp", "Create")])]);

    const capture = consumeHumanEdits(cwd);
    expect(capture.result.metadata?.humanEditsDetected).toBe(true);
    const afterConsume = readdirSync(editLoggingDir(cwd));
    expect(afterConsume.some((name) => name.endsWith(".consuming"))).toBe(true);
    expect(afterConsume).not.toContain("EditLog.json");

    capture.finalize();
    expect(readdirSync(editLoggingDir(cwd))).toEqual([]);
  });

  test("re-reads leftover .consuming files from a crashed turn", () => {
    const cwd = projectDir();
    const dir = editLoggingDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "EditLog.json.old.consuming"),
      JSON.stringify(envelope("Create", [subject("Part", "p1", "Old", "Create")])),
    );
    writeEditLog(cwd, [envelope("Create", [subject("Part", "p2", "New", "Create")])]);

    const { result } = consumeHumanEdits(cwd);
    expect(result.output).toContain('+ Part "Old" (p1)');
    expect(result.output).toContain('+ Part "New" (p2)');
  });

  test("counts malformed envelopes but keeps the parsable ones", () => {
    const cwd = projectDir();
    const dir = editLoggingDir(cwd);
    mkdirSync(dir, { recursive: true });
    // A brace-balanced but invalid chunk is a parse failure; a truncated tail
    // (mid-append) is silently dropped instead.
    writeFileSync(
      join(dir, "EditLog.json"),
      `${JSON.stringify(envelope("Create", [subject("Part", "p2", "Ramp", "Create")]))}\n{"bad": }\n{"truncated`,
    );

    const { result } = consumeHumanEdits(cwd);
    expect(result.output).toContain('+ Part "Ramp" (p2)');
    expect(result.output).toContain("1 log entries could not be parsed");
  });

  test("accepts a whole-file JSON array as well as JSONL", () => {
    const cwd = projectDir();
    const dir = editLoggingDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "EditLog.json"),
      JSON.stringify([envelope("Create", [subject("Part", "p2", "Ramp", "Create")])]),
    );

    const { result } = consumeHumanEdits(cwd);
    expect(result.output).toContain('+ Part "Ramp" (p2)');
  });
});

describe("createHumanEditsTool", () => {
  test("serves the turn-start cache and reports edits made during the turn", async () => {
    const cwd = projectDir();
    writeEditLog(cwd, [envelope("Create", [subject("Part", "p2", "Ramp", "Create")])]);
    const capture = consumeHumanEdits(cwd);
    capture.finalize();

    // Human keeps editing while the agent works.
    writeEditLog(cwd, [envelope("Delete", [subject("Part", "p9", "Crate", "Delete")])]);

    const tool = createHumanEditsTool(cwd, () => capture.result);
    const result = await tool.execute({} as never, toolCtx());
    expect(result.output).toContain('+ Part "Ramp" (p2)');
    expect(result.output).toContain("while this turn was in progress");
    expect(result.output).toContain('- Part "Crate" (p9)');
    // Peek must not consume: the mid-turn log stays for the next turn.
    expect(readdirSync(editLoggingDir(cwd))).toContain("EditLog.json");
  });

  test("returns the no-edits message when nothing is pending or cached", async () => {
    const result = await createHumanEditsTool(projectDir()).execute({} as never, toolCtx());
    expect(result.output).toBe(NO_EDITS);
    expect(result.metadata?.error).toBeUndefined();
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

describe("human-edits unified loop-hook context injection", () => {
  function promptProvider() {
    const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
    return provider as typeof provider & {
      onUserPromptSubmit: NonNullable<typeof provider.onUserPromptSubmit>;
    };
  }

  test("consumes the log in the outer hook and injects the summary through an Agent loop hook", async () => {
    const cwd = projectDir();
    writeEditLog(cwd, [envelope("Create", [subject("Part", "p2", "Ramp", "Create")])]);
    const p = promptProvider();

    const result = await p.onUserPromptSubmit(promptInput(cwd));
    expect(result.additionalContext).toBeUndefined();

    const hook = p.createAgentLoopHooks?.({ agentKind: "main" } as never)[0];
    expect(hook).toBeDefined();
    hook?.onPromptStart?.({ messages: [] });
    const injections = hook?.beforeTurn?.({ messages: [], turnId: "turn-1", compactedThisTurn: false });
    expect(injections).toHaveLength(1);
    expect(injections?.[0]).toMatchObject({
      source: "studiorpc-human-edits",
      metadata: {
        presentation: { kind: "human-edits", title: "Human edits detected" },
      },
    });
    expect(injections?.[0]?.content).toContain('+ Part "Ramp" (p2)');
    // Injection delivered -> consumed log files are gone.
    expect(readdirSync(editLoggingDir(cwd))).toEqual([]);
  });

  test("injects nothing when the log is empty", async () => {
    const cwd = projectDir();
    const p = promptProvider();
    await p.onUserPromptSubmit(promptInput(cwd));
    const hook = p.createAgentLoopHooks?.({ agentKind: "main" } as never)[0];
    hook?.onPromptStart?.({ messages: [] });
    expect(hook?.beforeTurn?.({ messages: [], turnId: "turn-1", compactedThisTurn: false })).toBeUndefined();
  });

  test("does not call any RPC at turn start", async () => {
    const calls: string[] = [];
    const provider = createStudioRpcToolProvider({
      callRpc: async (method) => {
        calls.push(method);
        return {};
      },
    });
    const p = provider as typeof provider & { onUserPromptSubmit: NonNullable<typeof provider.onUserPromptSubmit> };
    await p.onUserPromptSubmit(promptInput(projectDir()));
    expect(calls).toEqual([]);
    expect(provider.onStop).toBeUndefined();
  });

  test("does not register the Studio human-edits loop hook for child agents", () => {
    const p = promptProvider();
    expect(p.createAgentLoopHooks?.({ agentKind: "child" } as never)).toEqual([]);
  });
});
