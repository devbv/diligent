import { describe, expect, test, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "../src/infrastructure/diligent-dir";
import { SessionManager } from "../src/session/manager";
import { SESSION_VERSION } from "../src/session/types";
import type { ModeChangeEntry } from "../src/session/types";
import type { Model, ProviderEvent, ProviderResult, StreamFunction } from "../src/provider/types";
import { EventStream } from "../src/event-stream";
import type { AssistantMessage } from "../src/types";

const TEST_ROOT = join(tmpdir(), `diligent-session-mode-test-${Date.now()}`);

afterEach(async () => {
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

const TEST_MODEL: Model = {
  id: "test-model",
  provider: "test",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
};

function makeAssistant(text = "ok"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: TEST_MODEL.id,
    usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function createStreamFn(): StreamFunction {
  return (_model, _context, _opts) => {
    const msg = makeAssistant();
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (e) => e.type === "done" || e.type === "error",
      (e) => {
        if (e.type === "done") return { message: e.message };
        throw (e as { type: "error"; error: Error }).error;
      },
    );
    queueMicrotask(() => {
      stream.push({ type: "start" });
      stream.push({ type: "done", stopReason: "end_turn", message: msg });
    });
    return stream;
  };
}

describe("SESSION_VERSION", () => {
  test("is 4", () => {
    expect(SESSION_VERSION).toBe(4);
  });
});

describe("ModeChangeEntry JSON round-trip", () => {
  test("round-trips through JSON.parse(JSON.stringify())", () => {
    const entry: ModeChangeEntry = {
      type: "mode_change",
      id: "abc12345",
      parentId: "parent00",
      timestamp: new Date().toISOString(),
      mode: "plan",
      changedBy: "command",
    };
    const roundTripped = JSON.parse(JSON.stringify(entry)) as ModeChangeEntry;
    expect(roundTripped).toEqual(entry);
  });

  test("all changedBy values serialize correctly", () => {
    for (const changedBy of ["cli", "command", "config"] as const) {
      const entry: ModeChangeEntry = {
        type: "mode_change",
        id: "abc12345",
        parentId: null,
        timestamp: new Date().toISOString(),
        mode: "execute",
        changedBy,
      };
      const rt = JSON.parse(JSON.stringify(entry)) as ModeChangeEntry;
      expect(rt.changedBy).toBe(changedBy);
    }
  });
});

describe("SessionManager.appendModeChange()", () => {
  test("appends mode_change entry to session", async () => {
    const dir = join(TEST_ROOT, "mode-change");
    await mkdir(dir, { recursive: true });
    const paths = resolvePaths(dir);

    const manager = new SessionManager({
      cwd: dir,
      paths,
      agentConfig: {
        model: TEST_MODEL,
        systemPrompt: "test",
        tools: [],
        streamFunction: createStreamFn(),
      },
    });
    await manager.create();

    manager.appendModeChange("plan", "command");
    await manager.waitForWrites();

    expect(manager.entryCount).toBe(1);
  });

  test("default changedBy is 'command'", async () => {
    const dir = join(TEST_ROOT, "mode-change-default");
    await mkdir(dir, { recursive: true });
    const paths = resolvePaths(dir);

    const manager = new SessionManager({
      cwd: dir,
      paths,
      agentConfig: {
        model: TEST_MODEL,
        systemPrompt: "test",
        tools: [],
        streamFunction: createStreamFn(),
      },
    });
    await manager.create();

    // Should not throw when called without second argument
    expect(() => manager.appendModeChange("execute")).not.toThrow();
  });
});
