// @summary Tests for transcript store state reduction and rendering-adjacent behavior
import { describe, expect, test } from "bun:test";
import { ThreadStore } from "../../../src/tui/components/thread-store";
import { renderCommittedTranscriptItems, renderTranscript } from "../../../src/tui/components/transcript-render";

function stripAnsi(input: string): string {
  let out = "";
  let i = 0;

  while (i < input.length) {
    if (input.charCodeAt(i) === 27 && input[i + 1] === "[") {
      i += 2;
      while (i < input.length) {
        const ch = input[i];
        if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += input[i];
    i++;
  }

  return out;
}

describe("ThreadStore", () => {
  test("captures streamed assistant text into transcript items", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "agent_start" });
    store.handleEvent({ type: "message_start" });
    store.handleEvent({ type: "message_delta", delta: { type: "text_delta", delta: "hello" } });
    store.handleEvent({ type: "message_end" });

    const items = store.getItems();
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ kind: "assistant_chunk", text: "hello", continued: false });
  });

  test("keeps streamed markdown as a single committed assistant item at message end", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "message_start" });
    store.handleEvent({ type: "message_delta", delta: { type: "text_delta", delta: "- item 1\n" } });
    store.handleEvent({ type: "message_delta", delta: { type: "text_delta", delta: "- item 2" } });

    expect(store.getItems()).toEqual([]);

    store.handleEvent({ type: "message_end" });

    const items = store.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "assistant_chunk",
      text: "- item 1\n- item 2",
      continued: false,
    });
  });

  test("discarded streamed message clears active markdown before retry", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "message_start" });
    store.handleEvent({ type: "message_delta", delta: { type: "text_delta", delta: "partial\n" } });
    expect(renderTranscript(store, 80).map(stripAnsi).join("\n")).toContain("partial");

    store.handleEvent({
      type: "message_discarded",
      itemId: "item-1",
      error: { name: "ProviderError", message: "stream failed", providerErrorType: "server_error" },
      nextAttempt: 2,
      maxAttempts: 5,
      delayMs: 1,
    });

    const rendered = renderTranscript(store, 80).map(stripAnsi).join("\n");
    expect(rendered).not.toContain("partial");
    expect(rendered).toContain("Reconnecting… 2/5");
  });

  test("renders runtime presentation with a client-owned recovery hint", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({
      type: "error",
      error: {
        name: "ProviderError",
        message: "raw auth detail",
        presentation: {
          message: "OpenAI rejected the saved credentials. Reconnect to continue.",
          recovery: { kind: "configure_provider", provider: "openai" },
        },
      },
      fatal: false,
    });

    const rendered = renderCommittedTranscriptItems(store.getItems(), 100).map(stripAnsi).join("\n");
    expect(rendered).toContain("OpenAI rejected the saved credentials. Reconnect to continue.");
    expect(rendered).toContain("Run /provider set openai to reconnect.");
    expect(rendered).not.toContain("raw auth detail");
  });

  test("renders structured context notices from the shared protocol", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({
      type: "context_notice",
      source: "studiorpc-human-edits",
      presentation: {
        kind: "human-edits",
        title: "Human edits detected",
        content: "Added (1):\n+ Part Ramp",
      },
    });

    const rendered = renderCommittedTranscriptItems(store.getItems(), 100).map(stripAnsi).join("\n");
    expect(rendered).toContain("Human edits detected");
    expect(rendered).toContain("Added (1):");
    expect(rendered).toContain("+ Part Ramp");
  });

  test("tracks active question independently from transcript items", () => {
    const store = new ThreadStore({ requestRender: () => {} });
    const question = {
      render: () => ["question"],
      handleInput: (_data: string) => {},
      invalidate: () => {},
    };

    store.setActiveQuestion(question);
    expect(store.hasActiveQuestion()).toBe(true);
    expect(store.getActiveQuestion()).toBe(question);

    store.setActiveQuestion(null);
    expect(store.hasActiveQuestion()).toBe(false);
  });

  test("renders pending steering messages in transcript active stack", () => {
    const store = new ThreadStore({ requestRender: () => {} });
    store.setPendingSteers(["change approach"]);

    const lines = renderTranscript(store, 80).map(stripAnsi);
    expect(lines.some((line) => line.includes("⚑ change approach"))).toBe(true);
  });

  test("renders multiline pending steering as first-line preview with more suffix", () => {
    const store = new ThreadStore({ requestRender: () => {} });
    store.setPendingSteers(["line 1\nline 2"]);

    const lines = renderTranscript(store, 80).map(stripAnsi);
    expect(lines.some((line) => line.includes("⚑ line 1 ... (more)"))).toBe(true);
    expect(lines.some((line) => line.includes("line 2"))).toBe(false);
    expect(lines.some((line) => line.includes("\n"))).toBe(false);
  });

  test("orders live stack so status is below streaming markdown", () => {
    const store = new ThreadStore({ requestRender: () => {} });
    store.handleEvent({ type: "status_change", status: "busy" });
    store.handleEvent({ type: "message_start" });
    store.handleEvent({ type: "message_delta", delta: { type: "text_delta", delta: `${"s".repeat(1100)} streaming` } });
    store.handleEvent({ type: "tool_start", toolName: "plan", toolCallId: "plan_1", input: {} });
    store.setPendingSteers(["change approach"]);
    store.setActiveQuestion({
      render: () => ["question prompt"],
      handleInput: (_data: string) => {},
      invalidate: () => {},
    });

    const lines = renderTranscript(store, 100).map(stripAnsi);
    const planningIndex = lines.findIndex((line) => line.includes("Planning"));
    const workingIndex = lines.findIndex((line) => line.includes("Working…"));
    const steeringIndex = lines.findIndex((line) => line.includes("⚑ change approach"));
    const questionIndex = lines.findIndex((line) => line.includes("question prompt"));

    expect(planningIndex).toBeGreaterThanOrEqual(0);
    expect(workingIndex).toBeGreaterThan(planningIndex);
    expect(steeringIndex).toBeGreaterThan(workingIndex);
    expect(questionIndex).toBeGreaterThan(steeringIndex);
  });

  test("triggers low-frequency periodic re-renders while active status is shown", async () => {
    let renderCount = 0;
    const store = new ThreadStore({
      requestRender: () => {
        renderCount++;
      },
    });

    store.handleEvent({ type: "agent_start" });
    const afterStart = renderCount;

    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(afterStart).toBeGreaterThan(0);
    expect(renderCount).toBeGreaterThan(afterStart);
  });

  test("turn_end clears lingering Working status even if pin flag drifted", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "status_change", status: "busy" });

    const before = renderTranscript(store, 80).map(stripAnsi);
    expect(before.some((line) => line.includes("Working…"))).toBe(true);

    store.handleEvent({
      type: "turn_end",
      threadId: "t1",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: 0,
      toolResults: [],
    });

    const after = renderTranscript(store, 80).map(stripAnsi);
    expect(after.some((line) => line.includes("Working…"))).toBe(false);
  });

  test("finishTurn clears lingering Working status without turn_end event", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "status_change", status: "busy" });
    const before = renderTranscript(store, 80).map(stripAnsi);
    expect(before.some((line) => line.includes("Working…"))).toBe(true);

    store.finishTurn();

    const after = renderTranscript(store, 80).map(stripAnsi);
    expect(after.some((line) => line.includes("Working…"))).toBe(false);
  });

  test("tool_end restores Working status while thread remains busy", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "status_change", status: "busy" });
    store.handleEvent({ type: "tool_start", toolName: "bash", toolCallId: "t1", input: { command: "echo hi" } });
    store.handleEvent({
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      output: "hi",
      isError: false,
      render: undefined,
    });

    const lines = renderTranscript(store, 80).map(stripAnsi);
    const workingIndex = lines.findIndex((line) => line.includes("Working…"));
    expect(workingIndex).toBeGreaterThanOrEqual(0);
  });

  test("Complete status omits elapsed time and has no forced blank line below", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "tool_start", toolName: "wait", toolCallId: "t1", input: { ids: ["a1"] } });
    store.handleEvent({ type: "tool_update", toolName: "wait", toolCallId: "t1", partialResult: "Complete" });

    const lines = renderTranscript(store, 80).map(stripAnsi);
    const completeIndex = lines.findIndex((line) => line.includes("Complete"));
    expect(completeIndex).toBeGreaterThanOrEqual(0);
    expect(lines[completeIndex]).not.toMatch(/\([0-9]+(?:\.[0-9]+)?s\)/);
  });

  test("tool progress overlay uses white tone while active", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "tool_start", toolName: "bash", toolCallId: "tool_1", input: { command: "echo hi" } });

    const lines = renderTranscript(store, 80);
    const toolLine = lines.find((line) => line.includes("bash"));
    expect(toolLine).toBeDefined();
    if (!toolLine) throw new Error("Expected tool overlay line");
    expect(toolLine).toContain("\x1b[38;5;15m");
  });

  test("busy status persists under overlay and clears on idle", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "status_change", status: "busy" });
    store.handleEvent({ type: "tool_start", toolName: "bash", toolCallId: "t1", input: { command: "echo hi" } });

    const whileOverlay = renderTranscript(store, 80).map(stripAnsi);
    expect(whileOverlay.some((line) => line.includes("bash"))).toBe(true);
    expect(whileOverlay.some((line) => line.includes("Working…"))).toBe(true);

    store.handleEvent({
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      output: "hi",
      isError: false,
      render: undefined,
    });
    const afterOverlay = renderTranscript(store, 80).map(stripAnsi);
    expect(afterOverlay.some((line) => line.includes("Working…"))).toBe(true);

    store.handleEvent({ type: "status_change", status: "idle" });
    const afterIdle = renderTranscript(store, 80).map(stripAnsi);
    expect(afterIdle.some((line) => line.includes("Working…"))).toBe(false);
  });

  test("transcript restores blank separators between committed sections while keeping explicit timing spacing", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.addUserMessage("run this", { requestRender: false });
    store.addToolResultMessage({ toolName: "bash", output: "ok", isError: false });
    store.addAssistantMessage("done");
    store.addLines(["⏱ Loop 9.4s · Thought 0ms"], { separateBefore: true });

    const lines = renderCommittedTranscriptItems(store.getItems(), 80).map(stripAnsi);
    const toolIndex = lines.findIndex((line) => line.includes("bash"));
    const assistantIndex = lines.findIndex((line) => line.includes("done"));
    const timingIndex = lines.findIndex((line) => line.includes("Loop 9.4s"));

    expect(toolIndex).toBeGreaterThan(0);
    expect(assistantIndex).toBeGreaterThan(toolIndex);
    expect(lines[toolIndex - 1]).toBe("");
    expect(lines[assistantIndex - 1]).toBe("");
    expect(timingIndex).toBeGreaterThan(assistantIndex);
    expect(lines[timingIndex - 1]).toBe("");
  });

  test("read tool result header does not synthesize client render payloads", () => {
    const store = new ThreadStore({ requestRender: () => {}, cwd: "/Users/devbv-mini4/git/diligent" });

    store.handleEvent({
      type: "tool_start",
      toolCallId: "read_1",
      toolName: "read",
      input: { file_path: "/Users/devbv-mini4/git/diligent/packages/runtime/src/tools/render-payload.ts" },
    });
    store.handleEvent({
      type: "tool_end",
      toolCallId: "read_1",
      toolName: "read",
      output: "  1\tline one\n  2\tline two",
      isError: false,
    });

    const toolItem = store.getItems().find((item) => item.kind === "tool_result");
    expect(toolItem).toBeDefined();
    if (!toolItem || toolItem.kind !== "tool_result") throw new Error("Expected tool_result item");

    const readHeader = stripAnsi(toolItem.header);
    expect(readHeader).toBe("⏺ read");
    expect(toolItem.summaryLine).toBeUndefined();
    expect(toolItem.details.some((line) => stripAnsi(line).includes("line one"))).toBe(true);
  });

  test("bash tool result uses producer command render payload", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "tool_start", toolCallId: "bash_1", toolName: "bash", input: { command: "pwd" } });
    store.handleEvent({
      type: "tool_end",
      toolCallId: "bash_1",
      toolName: "bash",
      output: "/repo",
      isError: false,
      render: {
        inputSummary: "pwd",
        outputSummary: "Command completed",
        blocks: [{ type: "command", command: "pwd", output: "/repo", isError: false }],
      },
    });

    const toolItem = store.getItems().find((item) => item.kind === "tool_result");
    expect(toolItem).toBeDefined();
    if (!toolItem || toolItem.kind !== "tool_result") throw new Error("Expected tool_result item");

    expect(stripAnsi(toolItem.header)).toContain("bash - pwd");
    expect(toolItem.summaryLine).toBe("⎿  Command completed");
    const detailLines = toolItem.details.map(stripAnsi);
    expect(detailLines.some((line) => line.includes("$ pwd"))).toBe(true);
    expect(detailLines.some((line) => line.includes("/repo"))).toBe(true);
  });

  test("error tool_end still uses render header summary when payload exists", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "tool_start", toolCallId: "bash_err_1", toolName: "bash", input: { command: "exit 1" } });
    store.handleEvent({
      type: "tool_end",
      toolCallId: "bash_err_1",
      toolName: "bash",
      output: "[Exit code: 1]",
      isError: true,
      render: {
        inputSummary: "exit 1",
        outputSummary: "Command failed (exit 1)",
        blocks: [{ type: "command", command: "exit 1", output: "[Exit code: 1]", isError: true }],
      },
    });

    const toolItem = store.getItems().find((item) => item.kind === "tool_result");
    expect(toolItem).toBeDefined();
    if (!toolItem || toolItem.kind !== "tool_result") throw new Error("Expected tool_result item");

    const header = stripAnsi(toolItem.header);
    expect(header).toContain("✗ bash - exit 1");
    expect(toolItem.summaryLine).toBe("⎿  Command failed (exit 1)");
  });

  test("merges started request summary with completed response summary", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({
      type: "tool_start",
      toolCallId: "read_err_1",
      toolName: "read",
      input: { file_path: "README.md" },
      render: { inputSummary: "README.md", blocks: [] },
    });
    store.handleEvent({
      type: "tool_end",
      toolCallId: "read_err_1",
      toolName: "read",
      output: "Error: ENOENT",
      isError: true,
      render: { outputSummary: "Read failed", blocks: [] },
    });

    const toolItem = store.getItems().find((item) => item.kind === "tool_result");
    expect(toolItem).toBeDefined();
    if (!toolItem || toolItem.kind !== "tool_result") throw new Error("Expected tool_result item");

    const header = stripAnsi(toolItem.header);
    expect(header).toContain("read - README.md");
    expect(toolItem.summaryLine).toBe("⎿  Read failed");
  });

  test("expanded spawn_agent tool_result loads child thread detail preview", async () => {
    const store = new ThreadStore({
      requestRender: () => {},
      loadChildThread: async (_threadId) => ({
        cwd: "/repo",
        items: [
          {
            type: "agentMessage",
            itemId: "m1",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "child says hello" }],
              model: "x",
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              stopReason: "end_turn",
              timestamp: 1,
            },
          },
          {
            type: "toolCall",
            itemId: "t1",
            toolCallId: "tc1",
            toolName: "bash",
            input: { command: "echo hi" },
            output: "hi",
            isError: false,
            timestamp: 2,
            startedAt: 1,
            durationMs: 1,
          },
        ],
        hasFollowUp: false,
        entryCount: 2,
        isRunning: false,
        currentEffort: "medium",
      }),
    });

    store.handleEvent({ type: "tool_start", toolCallId: "spawn_1", toolName: "spawn_agent", input: {} });
    store.handleEvent({
      type: "tool_end",
      toolCallId: "spawn_1",
      toolName: "spawn_agent",
      output: JSON.stringify({ thread_id: "child-1", nickname: "fern" }),
      isError: false,
    });

    store.toggleToolResultsCollapsed();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const toolItem = store.getItems().find((item) => "kind" in item && item.kind === "tool_result");
    expect(toolItem).toBeDefined();
    if (!toolItem || !("kind" in toolItem) || toolItem.kind !== "tool_result")
      throw new Error("Expected tool_result item");

    expect(toolItem.childDetail?.status).toBe("loaded");
    const childLines = (toolItem.childDetail?.lines ?? []).map(stripAnsi);
    expect(childLines.some((line) => line.includes("Child thread preview:"))).toBe(true);
    expect(childLines.some((line) => line.includes("assistant=1, tools=1"))).toBe(true);
    expect(childLines.some((line) => line.includes("child says hello"))).toBe(true);
  });

  test("child-thread streaming events are not rendered in parent transcript", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({
      type: "message_start",
      itemId: "child-msg-1",
      message: {
        role: "assistant",
        content: [],
        model: "x",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "tool_use",
        timestamp: 1,
      },
      childThreadId: "child-1",
      nickname: "fern",
    });
    store.handleEvent({
      type: "message_delta",
      itemId: "child-msg-1",
      delta: { type: "text_delta", delta: "child streaming" },
      childThreadId: "child-1",
      nickname: "fern",
    });
    store.handleEvent({
      type: "message_end",
      itemId: "child-msg-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "child streaming" }],
        model: "x",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: 2,
      },
      childThreadId: "child-1",
      nickname: "fern",
    });
    store.handleEvent({
      type: "tool_start",
      toolCallId: "child-tool-1",
      toolName: "bash",
      input: { command: "echo hi" },
      childThreadId: "child-1",
      nickname: "fern",
    });
    store.handleEvent({
      type: "tool_end",
      toolCallId: "child-tool-1",
      toolName: "bash",
      output: "hi",
      isError: false,
      childThreadId: "child-1",
      nickname: "fern",
    });

    expect(store.getItems()).toHaveLength(0);
  });

  test("wait overlay prefers known agent nicknames over thread ids", () => {
    const store = new ThreadStore({ requestRender: () => {} });

    store.handleEvent({ type: "tool_start", toolCallId: "spawn_1", toolName: "spawn_agent", input: {} });
    store.handleEvent({
      type: "tool_end",
      toolCallId: "spawn_1",
      toolName: "spawn_agent",
      output: JSON.stringify({ thread_id: "child-abc", nickname: "Holly" }),
      isError: false,
    });

    store.handleEvent({ type: "tool_start", toolCallId: "wait_1", toolName: "wait", input: { ids: ["child-abc"] } });
    const lines = renderTranscript(store, 100).map(stripAnsi);
    expect(lines.some((line) => line.includes("Waiting for Holly"))).toBe(true);
  });
});
