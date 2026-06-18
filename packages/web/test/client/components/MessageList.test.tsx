// @summary MessageList rendering invariants for virtualized transcript rows
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageList } from "../../../src/client/components/MessageList";
import type { RenderItem } from "../../../src/client/lib/thread-store";

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
