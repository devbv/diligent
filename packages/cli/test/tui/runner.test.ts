// @summary Tests for non-interactive runner behavior via app-server JSON-RPC path
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  DiligentPaths,
  Model,
  ProviderEvent,
  StreamContext,
  StreamFunction,
} from "@diligent/runtime";
import { EventStream, ensureDiligentDir } from "@diligent/runtime";
import type { AppConfig } from "../../src/config";
import { ProviderManager } from "../../src/provider-manager";
import { NonInteractiveRunner } from "../../src/tui/runner";
import { createInProcessRpcClientFactory } from "../helpers/in-process-server";

const TEST_MODEL: Model = {
  modelId: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
};

interface ScriptStep {
  events?: ProviderEvent[];
  message?: AssistantMessage;
  error?: Error;
  awaitAbort?: boolean;
}

function createAssistantMessage(args: {
  text?: string;
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
  usage?: AssistantMessage["usage"];
}): AssistantMessage {
  const usage = args.usage ?? {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  const content: AssistantMessage["content"] = [];
  if (args.text) {
    content.push({ type: "text", text: args.text });
  }
  if (args.toolCall) {
    content.push({
      type: "tool_call",
      id: args.toolCall.id,
      name: args.toolCall.name,
      input: args.toolCall.input,
    });
  }

  return {
    role: "assistant",
    content,
    model: TEST_MODEL,
    usage,
    stopReason: args.toolCall ? "tool_use" : "end_turn",
    timestamp: Date.now(),
  };
}

function createScriptedStreamFunction(steps: ScriptStep[], calls: StreamContext[] = []): StreamFunction {
  let callIndex = 0;

  return (_model, context, options) => {
    calls.push(context);

    const step = steps[Math.min(callIndex, steps.length - 1)] ?? {
      message: createAssistantMessage({ text: "" }),
    };
    callIndex++;

    const stream = new EventStream<ProviderEvent, { message: AssistantMessage }>(
      (event) => event.type === "done",
      (event) => ({ message: event.message }),
    );

    if (step.awaitAbort) {
      const onAbort = () => {
        const error = new Error("aborted");
        stream.push({ type: "error", error });
        stream.error(error);
      };

      if (options.signal?.aborted) {
        onAbort();
      } else {
        options.signal?.addEventListener("abort", onAbort, { once: true });
      }

      return stream;
    }

    queueMicrotask(() => {
      for (const event of step.events ?? []) {
        stream.push(event);
      }

      if (step.error) {
        stream.push({ type: "error", error: step.error });
        stream.error(step.error);
        return;
      }

      const message = step.message ?? createAssistantMessage({ text: "" });
      stream.push({
        type: "done",
        stopReason: message.stopReason,
        message,
      });
      stream.end({ message });
    });

    return stream;
  };
}

function makeConfig(streamFunction: StreamFunction): AppConfig {
  const pm = new ProviderManager({});
  pm.setApiKey("anthropic", "test-key");
  return {
    apiKey: "test-key",
    model: TEST_MODEL,
    systemPrompt: [{ label: "test", content: "test prompt" }],
    streamFunction,
    diligent: {},
    sources: [],
    skills: [],
    mode: "default",
    providerManager: pm,
  };
}

async function setupWorkspace(prefix: string): Promise<{ root: string; paths: DiligentPaths; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const paths = await ensureDiligentDir(dir);

  return {
    root: dir,
    paths,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function captureOutput(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prevStdoutWrite = process.stdout.write;
  const prevStderrWrite = process.stderr.write;

  const captureStdoutWrite = ((...args: Parameters<typeof process.stdout.write>) => {
    const [chunk] = args;
    stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
    return prevStdoutWrite.apply(process.stdout, args);
  }) as typeof process.stdout.write;

  const captureStderrWrite = ((...args: Parameters<typeof process.stderr.write>) => {
    const [chunk] = args;
    stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return prevStderrWrite.apply(process.stderr, args);
  }) as typeof process.stderr.write;

  process.stdout.write = captureStdoutWrite;
  process.stderr.write = captureStderrWrite;

  return {
    stdout,
    stderr,
    restore: () => {
      if (process.stdout.write === captureStdoutWrite) {
        process.stdout.write = prevStdoutWrite;
      }
      if (process.stderr.write === captureStderrWrite) {
        process.stderr.write = prevStderrWrite;
      }
    },
  };
}

describe("NonInteractiveRunner", () => {
  test("returns exit 1 when .diligent paths are unavailable", async () => {
    const streamFn = createScriptedStreamFunction([{ message: createAssistantMessage({ text: "unused" }) }]);
    const { stderr, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(streamFn));
      const exitCode = await runner.run("hello");
      expect(exitCode).toBe(1);
    } finally {
      restore();
    }

    expect(stderr.join("")).toContain("No .diligent directory");
  });

  test("basic prompt -> stdout text output, exit 0", async () => {
    const workspace = await setupWorkspace("diligent-runner-test-");
    const streamFn = createScriptedStreamFunction([
      {
        events: [{ type: "start" }, { type: "text_delta", delta: "Hello " }, { type: "text_delta", delta: "world!" }],
        message: createAssistantMessage({ text: "Hello world!" }),
      },
    ]);

    const { stdout, restore } = captureOutput();
    try {
      const cfg = makeConfig(streamFn);
      const runner = new NonInteractiveRunner(cfg, workspace.paths, {
        rpcClientFactory: createInProcessRpcClientFactory(cfg, workspace.paths, workspace.root),
      });
      const exitCode = await runner.run("say hello");
      expect(exitCode).toBe(0);
    } finally {
      restore();
      workspace.cleanup();
    }

    const allStdout = stdout.join("");
    expect(allStdout).toContain("Hello ");
    expect(allStdout).toContain("world!");
    expect(allStdout.endsWith("\n")).toBe(true);
  });

  test("tool events -> stderr only", async () => {
    const workspace = await setupWorkspace("diligent-runner-test-");
    const streamFn = createScriptedStreamFunction([
      {
        message: createAssistantMessage({
          toolCall: { id: "tc_1", name: "bash", input: { command: "echo hi" } },
        }),
      },
      {
        events: [{ type: "text_delta", delta: "Done" }],
        message: createAssistantMessage({ text: "Done" }),
      },
    ]);

    const { stdout, stderr, restore } = captureOutput();
    try {
      const cfg = makeConfig(streamFn);
      const runner = new NonInteractiveRunner(cfg, workspace.paths, {
        rpcClientFactory: createInProcessRpcClientFactory(cfg, workspace.paths, workspace.root),
      });
      const exitCode = await runner.run("run echo");
      expect(exitCode).toBe(0);
    } finally {
      restore();
      workspace.cleanup();
    }

    const allStdout = stdout.join("");
    const allStderr = stderr.join("");
    expect(allStderr).toContain("[tool:bash] Running...");
    expect(allStderr).toContain("[tool:bash] Done (");
    expect(allStdout).toContain("Done");
    expect(allStdout).not.toContain("[tool:");
  });

  test("provider error -> exit 1", async () => {
    const workspace = await setupWorkspace("diligent-runner-test-");
    const streamFn = createScriptedStreamFunction([{ error: new Error("rate limit exceeded") }]);

    const { stderr, restore } = captureOutput();
    try {
      const cfg = makeConfig(streamFn);
      const runner = new NonInteractiveRunner(cfg, workspace.paths, {
        rpcClientFactory: createInProcessRpcClientFactory(cfg, workspace.paths, workspace.root),
      });
      const exitCode = await runner.run("fail");
      expect(exitCode).toBe(1);
    } finally {
      restore();
      workspace.cleanup();
    }

    expect(stderr.join("")).toContain("[error] rate limit exceeded");
  });

  test("passes user prompt in stream context", async () => {
    const workspace = await setupWorkspace("diligent-runner-test-");
    const calls: StreamContext[] = [];
    const streamFn = createScriptedStreamFunction([{ message: createAssistantMessage({ text: "ok" }) }], calls);

    const { restore } = captureOutput();
    try {
      const cfg = makeConfig(streamFn);
      const runner = new NonInteractiveRunner(cfg, workspace.paths, {
        rpcClientFactory: createInProcessRpcClientFactory(cfg, workspace.paths, workspace.root),
      });
      await runner.run("hello agent");
    } finally {
      restore();
      workspace.cleanup();
    }

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.systemPrompt).toEqual([{ label: "test", content: "test prompt" }]);
    const containsPrompt = calls.some((call) =>
      call.messages.some((message) => message.role === "user" && message.content === "hello agent"),
    );
    expect(containsPrompt).toBe(true);
  });

  test("thinking_delta is not written to stdout", async () => {
    const workspace = await setupWorkspace("diligent-runner-test-");
    const streamFn = createScriptedStreamFunction([
      {
        events: [
          { type: "thinking_delta", delta: "internal thought" },
          { type: "text_delta", delta: "visible" },
        ],
        message: createAssistantMessage({ text: "visible" }),
      },
    ]);

    const { stdout, restore } = captureOutput();
    try {
      const cfg = makeConfig(streamFn);
      const runner = new NonInteractiveRunner(cfg, workspace.paths, {
        rpcClientFactory: createInProcessRpcClientFactory(cfg, workspace.paths, workspace.root),
      });
      await runner.run("think");
    } finally {
      restore();
      workspace.cleanup();
    }

    const allStdout = stdout.join("");
    expect(allStdout).toContain("visible");
    expect(allStdout).not.toContain("internal thought");
  });

  test("no text output -> no trailing newline", async () => {
    const workspace = await setupWorkspace("diligent-runner-test-");
    const streamFn = createScriptedStreamFunction([
      {
        message: createAssistantMessage({
          toolCall: { id: "tc_1", name: "bash", input: { command: "ls" } },
        }),
      },
      { message: createAssistantMessage({ text: "" }) },
    ]);

    const { stdout, restore } = captureOutput();
    try {
      const cfg = makeConfig(streamFn);
      const runner = new NonInteractiveRunner(cfg, workspace.paths, {
        rpcClientFactory: createInProcessRpcClientFactory(cfg, workspace.paths, workspace.root),
      });
      const exitCode = await runner.run("list files");
      expect(exitCode).toBe(0);
    } finally {
      restore();
      workspace.cleanup();
    }

    expect(stdout.join("")).toBe("");
  });

  test("rings terminal bell when turn completes", async () => {
    const workspace = await setupWorkspace("diligent-runner-test-");
    const streamFn = createScriptedStreamFunction([{ message: createAssistantMessage({ text: "ok" }) }]);

    const { stderr, restore } = captureOutput();
    try {
      const cfg = makeConfig(streamFn);
      const runner = new NonInteractiveRunner(cfg, workspace.paths, {
        rpcClientFactory: createInProcessRpcClientFactory(cfg, workspace.paths, workspace.root),
      });
      const exitCode = await runner.run("ping");
      expect(exitCode).toBe(0);
    } finally {
      restore();
      workspace.cleanup();
    }

    expect(stderr.join("")).toContain("\x07");
  });

  test("terminal bell can be disabled via config", async () => {
    const workspace = await setupWorkspace("diligent-runner-test-");
    const streamFn = createScriptedStreamFunction([{ message: createAssistantMessage({ text: "ok" }) }]);

    const { stderr, restore } = captureOutput();
    try {
      const cfg = makeConfig(streamFn);
      cfg.diligent = { ...cfg.diligent, terminalBell: false };
      const runner = new NonInteractiveRunner(cfg, workspace.paths, {
        rpcClientFactory: createInProcessRpcClientFactory(cfg, workspace.paths, workspace.root),
      });
      const exitCode = await runner.run("ping");
      expect(exitCode).toBe(0);
    } finally {
      restore();
      workspace.cleanup();
    }

    expect(stderr.join("")).not.toContain("\x07");
  });
});
