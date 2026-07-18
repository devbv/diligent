// @summary App-server e2e coverage for custom agents and per-spawn child-tool caps
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent, ProviderResult } from "@diligent/core/provider-contract";
import { EventStream, type StreamFunction } from "@diligent/runtime";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

let tmpDir = "";
let client: ProtocolTestClient;

function createCustomAgentScenarioStream(): StreamFunction {
  return (_model, context) => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done",
      (event) => ({ message: (event as Extract<ProviderEvent, { type: "done" }>).message }),
    );

    queueMicrotask(() => {
      stream.push({ type: "start" });

      const lastMessage = context.messages[context.messages.length - 1];
      const agentRole = context.systemPrompt.find((section) => section.label === "agent_role")?.content ?? "";
      const isChildReviewer = agentRole.includes("You are a code reviewer.");

      if (!isChildReviewer && lastMessage?.role === "user") {
        const lastUserText = lastMessage.content;
        if (typeof lastUserText === "string" && lastUserText === "start review") {
          const input = {
            message: "Review this change",
            description: "custom reviewer",
            agent_type: "code-reviewer",
            allowed_tools: ["read"],
          };
          stream.push({ type: "tool_call_start", id: "tc-spawn", name: "spawn_agent" });
          stream.push({ type: "tool_call_end", id: "tc-spawn", name: "spawn_agent", input });
          stream.push({
            type: "done",
            stopReason: "tool_use",
            message: {
              role: "assistant",
              content: [{ type: "tool_call", id: "tc-spawn", name: "spawn_agent", input }],
              model: { provider: "anthropic", modelId: "claude-sonnet-5" },
              usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
              stopReason: "tool_use",
              timestamp: Date.now(),
            },
          });
          return;
        }
      }

      if (!isChildReviewer && lastMessage?.role === "tool_result" && lastMessage.toolName === "spawn_agent") {
        const parsed = JSON.parse(lastMessage.output) as { thread_id: string };
        const input = { ids: [parsed.thread_id], timeout_ms: 10_000 };
        stream.push({ type: "tool_call_start", id: "tc-wait", name: "wait" });
        stream.push({ type: "tool_call_end", id: "tc-wait", name: "wait", input });
        stream.push({
          type: "done",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            content: [{ type: "tool_call", id: "tc-wait", name: "wait", input }],
            model: { provider: "anthropic", modelId: "claude-sonnet-5" },
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            stopReason: "tool_use",
            timestamp: Date.now(),
          },
        });
        return;
      }

      if (isChildReviewer && lastMessage?.role === "user") {
        const input = { pattern: "TODO", path: "/tmp/project", include: "*.ts", ignore_case: false, context: 0 };
        stream.push({ type: "tool_call_start", id: "tc-grep", name: "grep" });
        stream.push({ type: "tool_call_end", id: "tc-grep", name: "grep", input });
        stream.push({
          type: "done",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            content: [{ type: "tool_call", id: "tc-grep", name: "grep", input }],
            model: { provider: "anthropic", modelId: "claude-sonnet-5" },
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            stopReason: "tool_use",
            timestamp: Date.now(),
          },
        });
        return;
      }

      if (isChildReviewer && lastMessage?.role === "tool_result" && lastMessage.toolName === "grep") {
        const text = "child complete after tool cap";
        stream.push({ type: "text_delta", delta: text });
        stream.push({
          type: "done",
          stopReason: "end_turn",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            model: { provider: "anthropic", modelId: "claude-sonnet-5" },
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            stopReason: "end_turn",
            timestamp: Date.now(),
          },
        });
        return;
      }

      const text = isChildReviewer ? "child complete after tool cap" : "parent complete after wait";
      stream.push({ type: "text_delta", delta: text });
      stream.push({
        type: "done",
        stopReason: "end_turn",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          model: { provider: "anthropic", modelId: "claude-sonnet-5" },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: Date.now(),
        },
      });
    });

    return stream;
  };
}

afterEach(async () => {
  client?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  tmpDir = "";
});

describe("custom agents", () => {
  test("custom agent spawns and per-spawn allowed_tools narrows child access through the protocol boundary", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-custom-agents-"));
    await mkdir(join(tmpDir, ".diligent", "agents", "code-reviewer"), { recursive: true });
    await writeFile(
      join(tmpDir, ".diligent", "agents", "code-reviewer", "AGENT.md"),
      [
        "---",
        "name: code-reviewer",
        "description: Reviews code for quality and best practices",
        "tools: read, glob, grep",
        "model_class: general",
        "---",
        "You are a code reviewer.",
      ].join("\n"),
    );

    const server = createTestServer({
      cwd: tmpDir,
      runtimeToolsConfig: { builtin: { grep: true, read: true, glob: true } },
      runtimeConfigOverrides: {
        systemPrompt: [{ label: "agents", content: "## Available Agents\n- **code-reviewer**" }],
        agents: [
          {
            name: "code-reviewer",
            description: "Reviews code for quality and best practices",
            filePath: join(tmpDir, ".diligent", "agents", "code-reviewer", "AGENT.md"),
            content: "You are a code reviewer.",
            tools: ["read", "glob", "grep"],
            defaultModelClass: "general",
            source: "project",
          },
        ],
      },
      streamFunction: createCustomAgentScenarioStream(),
    });
    client = createProtocolClient(server);

    const threadId = await client.initAndStartThread(tmpDir);
    const notifications = await client.sendTurnAndWait(threadId, "start review");

    expect(
      notifications.some(
        (notification) =>
          notification.method === "agent/event" &&
          (notification.params as { event: { type: string; agentType?: string } }).event.type ===
            "collab_spawn_begin" &&
          (notification.params as { event: { type: string; agentType?: string } }).event.agentType === "code-reviewer",
      ),
    ).toBe(true);

    expect(
      notifications.some(
        (notification) =>
          notification.method === "agent/event" &&
          (
            notification.params as {
              event: { type: string; toolName?: string; output?: string; isError?: boolean; childThreadId?: string };
            }
          ).event.type === "tool_end" &&
          (
            notification.params as {
              event: { type: string; toolName?: string; output?: string; isError?: boolean; childThreadId?: string };
            }
          ).event.childThreadId !== undefined &&
          (
            notification.params as {
              event: { type: string; toolName?: string; output?: string; isError?: boolean; childThreadId?: string };
            }
          ).event.toolName === "grep" &&
          (
            notification.params as {
              event: { type: string; toolName?: string; output?: string; isError?: boolean; childThreadId?: string };
            }
          ).event.isError === true &&
          (
            (
              notification.params as {
                event: { type: string; toolName?: string; output?: string; isError?: boolean; childThreadId?: string };
              }
            ).event.output ?? ""
          ).includes('Unknown tool "grep"'),
      ),
    ).toBe(true);

    const readResult = (await client.request("thread/read", { threadId })) as {
      items: Array<{ type: string; toolName?: string; output?: string }>;
    };
    expect(readResult.items.some((item) => item.type === "toolCall" && item.toolName === "wait")).toBe(true);
  });
});
