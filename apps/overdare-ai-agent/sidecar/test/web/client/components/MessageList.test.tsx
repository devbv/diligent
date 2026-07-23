// @summary MessageList rendering invariants for virtualized transcript rows
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageList } from "../../../../src/web/client/components/MessageList";
import type { RenderItem } from "../../../../src/web/client/lib/thread-store";

test("MessageList renders every row during static rendering", () => {
  const items: RenderItem[] = Array.from({ length: 18 }, (_, index) => ({
    id: `user-${index}`,
    kind: "user",
    text: `static row ${index}`,
    images: [],
    timestamp: index,
  }));

  const html = renderToStaticMarkup(
    <MessageList
      items={items}
      threadStatus="idle"
      hasProvider={true}
      onOpenProviders={() => {}}
      onQuickConnectChatGPT={() => {}}
    />,
  );

  expect(html).toContain("static row 0");
  expect(html).toContain("static row 17");
  expect((html.match(/data-message-list-row="user-/g) ?? []).length).toBe(18);
});

test("MessageList groups consecutive mixed tool activity rows", () => {
  const items: RenderItem[] = [
    {
      id: "tool-read",
      kind: "tool",
      toolName: "read",
      inputText: "src/App.tsx",
      outputText: "",
      isError: false,
      status: "done",
      timestamp: 1,
      toolCallId: "call-read",
      startedAt: 1,
      durationMs: 4,
      render: { inputSummary: "src/App.tsx", blocks: [] },
    },
    {
      id: "tool-grep",
      kind: "tool",
      toolName: "grep",
      inputText: "ToolBlock",
      outputText: "",
      isError: false,
      status: "done",
      timestamp: 2,
      toolCallId: "call-grep",
      startedAt: 2,
      durationMs: 9,
      render: { inputSummary: "ToolBlock", blocks: [] },
    },
    {
      id: "tool-bash",
      kind: "tool",
      toolName: "bash",
      inputText: "bun test",
      outputText: "",
      isError: false,
      status: "done",
      timestamp: 3,
      toolCallId: "call-bash",
      startedAt: 3,
      durationMs: 12,
      render: { inputSummary: "bun test", blocks: [] },
    },
    {
      id: "assistant-empty",
      kind: "assistant",
      text: "",
      thinking: "",
      contentBlocks: [],
      thinkingDone: true,
      timestamp: 4,
    },
    {
      id: "tool-plan",
      kind: "tool",
      toolName: "plan",
      inputText: "Update plan",
      outputText: "",
      isError: false,
      status: "done",
      timestamp: 5,
      toolCallId: "call-plan",
      startedAt: 5,
      durationMs: 1,
      render: { inputSummary: "Ship UI cleanup (3 steps)", blocks: [] },
    },
  ];

  const html = renderToStaticMarkup(
    <MessageList items={items} threadStatus="idle" hasProvider={true} onOpenProviders={() => {}} />,
  );

  expect(html).toContain('data-message-list-row="tool-group:tool-read+tool-grep+tool-bash+tool-plan"');
  expect(html).not.toContain('data-message-list-row="tool-read"');
  expect(html).toContain("Read 1 file, searched code, ran 1 command, and updated plan");
  expect(html).not.toContain("Read file: src/App.tsx");
  expect(html).not.toContain("Ran command: bun test");
  expect(html).not.toContain("Ship UI cleanup (3 steps)");
});

test("MessageList groups failed tool activity rows", () => {
  const items: RenderItem[] = [
    {
      id: "tool-glob-1",
      kind: "tool",
      toolName: "glob",
      inputText: "**/*.lua",
      outputText: "rg missing",
      isError: true,
      status: "done",
      timestamp: 1,
      toolCallId: "call-glob-1",
      startedAt: 1,
      durationMs: 4,
      render: { inputSummary: "**/*.lua", blocks: [] },
    },
    {
      id: "tool-glob-2",
      kind: "tool",
      toolName: "glob",
      inputText: "**/*.ovdrjm",
      outputText: "rg missing",
      isError: true,
      status: "done",
      timestamp: 2,
      toolCallId: "call-glob-2",
      startedAt: 2,
      durationMs: 6,
      render: { inputSummary: "**/*.ovdrjm", blocks: [] },
    },
  ];

  const html = renderToStaticMarkup(
    <MessageList items={items} threadStatus="idle" hasProvider={true} onOpenProviders={() => {}} />,
  );

  expect(html).toContain('data-message-list-row="tool-group:tool-glob-1+tool-glob-2"');
  expect(html).toContain("2 matches failed");
  expect(html).toContain("Failed");
  expect(html).toContain("text-muted/65");
  expect(html).not.toContain("text-danger");
  expect(html).not.toContain("**/*.lua");
});

test("MessageList preserves assistant text hiding before request_user_input tools", () => {
  const items: RenderItem[] = [
    {
      id: "assistant-1",
      kind: "assistant",
      text: "assistant text hidden before user input",
      thinking: "",
      contentBlocks: [],
      thinkingDone: true,
      timestamp: 1,
    },
    {
      id: "tool-1",
      kind: "tool",
      toolName: "request_user_input",
      inputText: "",
      outputText: "",
      isError: false,
      status: "streaming",
      timestamp: 2,
      toolCallId: "call-1",
      startedAt: 2,
    },
  ];

  const html = renderToStaticMarkup(
    <MessageList items={items} threadStatus="idle" hasProvider={true} onOpenProviders={() => {}} />,
  );

  expect(html).not.toContain("assistant text hidden before user input");
  expect(html).not.toContain('data-message-list-row="assistant-1"');
  expect((html.match(/data-message-list-row="/g) ?? []).length).toBe(2);
});

test("MessageList suppresses assistant thinking while compacting", () => {
  const items: RenderItem[] = [
    {
      id: "assistant-1",
      kind: "assistant",
      text: "visible assistant answer",
      thinking: "compaction should hide this thinking",
      contentBlocks: [],
      thinkingDone: false,
      timestamp: 1,
    },
  ];

  const html = renderToStaticMarkup(
    <MessageList items={items} threadStatus="busy" hasProvider={true} onOpenProviders={() => {}} isCompacting={true} />,
  );

  expect(html).toContain("visible assistant answer");
  expect(html).not.toContain("compaction should hide this thinking");
});

test("MessageList keeps following rows stable when compacting after hidden assistant rows", () => {
  const items: RenderItem[] = [
    {
      id: "assistant-1",
      kind: "assistant",
      text: "hidden assistant text",
      thinking: "",
      contentBlocks: [],
      thinkingDone: true,
      timestamp: 1,
    },
    {
      id: "tool-1",
      kind: "tool",
      toolName: "request_user_input",
      inputText: "",
      outputText: "",
      isError: false,
      status: "done",
      timestamp: 2,
      toolCallId: "call-1",
      startedAt: 2,
    },
  ];

  const html = renderToStaticMarkup(
    <MessageList items={items} threadStatus="busy" hasProvider={true} onOpenProviders={() => {}} isCompacting={true} />,
  );

  expect(html).not.toContain("hidden assistant text");
  expect(html).not.toContain('data-message-list-row="assistant-1"');
  expect(html).toContain('data-message-list-row="tool-1"');
  expect(html).toContain('data-message-list-row="status:compacting"');
  expect((html.match(/data-message-list-row="/g) ?? []).length).toBe(3);
});

test("MessageList marks the completed assistant response with the agent logo when idle", () => {
  const items: RenderItem[] = [
    {
      id: "user-1",
      kind: "user",
      text: "make it shiny",
      images: [],
      timestamp: 1,
    },
    {
      id: "assistant-1",
      kind: "assistant",
      text: "Understood. I have completed the update.",
      thinking: "",
      contentBlocks: [],
      thinkingDone: true,
      timestamp: 2,
    },
  ];

  const html = renderToStaticMarkup(
    <MessageList items={items} threadStatus="idle" hasProvider={true} onOpenProviders={() => {}} />,
  );

  expect(html).toContain('data-message-list-row="status:response-complete"');
  expect(html).toContain('aria-label="Response complete"');
});

test("MessageList hides the response-complete logo while the agent is busy", () => {
  const items: RenderItem[] = [
    {
      id: "assistant-1",
      kind: "assistant",
      text: "previous completed answer",
      thinking: "",
      contentBlocks: [],
      thinkingDone: true,
      timestamp: 1,
    },
  ];

  const html = renderToStaticMarkup(
    <MessageList items={items} threadStatus="busy" hasProvider={true} onOpenProviders={() => {}} />,
  );

  expect(html).not.toContain('data-message-list-row="status:response-complete"');
  expect(html).toContain('data-message-list-row="status:streaming"');
});

test("MessageList hides the response-complete logo when the turn did not end with an assistant response", () => {
  const items: RenderItem[] = [
    {
      id: "assistant-1",
      kind: "assistant",
      text: "answered earlier",
      thinking: "",
      contentBlocks: [],
      thinkingDone: true,
      timestamp: 1,
    },
    {
      id: "user-1",
      kind: "user",
      text: "interrupted follow-up",
      images: [],
      timestamp: 2,
    },
  ];

  const html = renderToStaticMarkup(
    <MessageList items={items} threadStatus="idle" hasProvider={true} onOpenProviders={() => {}} />,
  );

  expect(html).not.toContain('data-message-list-row="status:response-complete"');
});
