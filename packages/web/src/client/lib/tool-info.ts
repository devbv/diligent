// @summary Tool display name, icon, and category mapping for compact ToolCallRow rendering

import type { ToolRenderPayload } from "@diligent/protocol";
import { normalizeToolName } from "./thread-utils";

export interface ToolInfo {
  displayName: string;
  icon: ToolIconName;
  category: "context" | "action";
  activity: {
    done: string;
    running: string;
    failed: string;
  };
}

export type ToolIconName =
  | "agent"
  | "book"
  | "checklist"
  | "clock"
  | "edit"
  | "file"
  | "globe"
  | "input"
  | "list"
  | "plan"
  | "search"
  | "send"
  | "settings"
  | "sparkles"
  | "terminal";

function tool(
  displayName: string,
  icon: ToolIconName,
  category: ToolInfo["category"],
  activity: ToolInfo["activity"],
): ToolInfo {
  return { displayName, icon, category, activity };
}

// Keys are lowercase for case-insensitive matching
const TOOL_MAP: Record<string, ToolInfo> = {
  read: tool("Read", "file", "context", {
    done: "Read files",
    running: "Reading files",
    failed: "Read failed",
  }),
  read_image: tool("Image", "file", "context", {
    done: "Read image",
    running: "Reading image",
    failed: "Image read failed",
  }),
  grep: tool("Grep", "search", "context", {
    done: "Searched code",
    running: "Searching code",
    failed: "Search failed",
  }),
  glob: tool("Glob", "search", "context", {
    done: "Matched files",
    running: "Matching files",
    failed: "Match failed",
  }),
  ls: tool("List", "list", "context", {
    done: "Listed files",
    running: "Listing files",
    failed: "List failed",
  }),
  bash: tool("Shell", "terminal", "action", {
    done: "Ran command",
    running: "Running command",
    failed: "Command failed",
  }),
  write: tool("Write", "edit", "action", {
    done: "Wrote file",
    running: "Writing file",
    failed: "Write failed",
  }),
  edit: tool("Edit", "edit", "action", {
    done: "Edited file",
    running: "Editing file",
    failed: "Edit failed",
  }),
  apply_patch: tool("Patch", "edit", "action", {
    done: "Edited files",
    running: "Editing files",
    failed: "Edit failed",
  }),
  multi_edit: tool("Edit", "edit", "action", {
    done: "Edited files",
    running: "Editing files",
    failed: "Edit failed",
  }),
  multiedit: tool("Edit", "edit", "action", {
    done: "Edited files",
    running: "Editing files",
    failed: "Edit failed",
  }),
  skill: tool("Skill", "book", "context", {
    done: "Loaded skill",
    running: "Loading skill",
    failed: "Skill load failed",
  }),
  agent: tool("Agent", "agent", "action", {
    done: "Ran agent",
    running: "Running agent",
    failed: "Agent failed",
  }),
  web_action: tool("Web Action", "globe", "context", {
    done: "Searched web",
    running: "Searching web",
    failed: "Web action failed",
  }),
  web_search: tool("Web Search", "globe", "context", {
    done: "Searched web",
    running: "Searching web",
    failed: "Web search failed",
  }),
  web_fetch: tool("Web Fetch", "globe", "context", {
    done: "Opened page",
    running: "Opening page",
    failed: "Page open failed",
  }),
  overdaresearch: tool("Asset Search", "search", "context", {
    done: "Searched assets",
    running: "Searching assets",
    failed: "Asset search failed",
  }),
  todowrite: tool("Todo", "checklist", "action", {
    done: "Updated todos",
    running: "Updating todos",
    failed: "Todo update failed",
  }),
  todoread: tool("Todo", "checklist", "context", {
    done: "Read todos",
    running: "Reading todos",
    failed: "Todo read failed",
  }),
  request_user_input: tool("Input", "input", "context", {
    done: "Requested input",
    running: "Requesting input",
    failed: "Input request failed",
  }),
  notebookedit: tool("Notebook", "edit", "action", {
    done: "Edited notebook",
    running: "Editing notebook",
    failed: "Notebook edit failed",
  }),
  notebookread: tool("Notebook", "book", "context", {
    done: "Read notebook",
    running: "Reading notebook",
    failed: "Notebook read failed",
  }),
  plan: tool("Plan", "plan", "action", {
    done: "Updated plan",
    running: "Updating plan",
    failed: "Plan update failed",
  }),
  spawn_agent: tool("Spawn", "agent", "action", {
    done: "Started agent",
    running: "Starting agent",
    failed: "Agent start failed",
  }),
  wait: tool("Wait", "clock", "action", {
    done: "Waited for agents",
    running: "Waiting for agents",
    failed: "Wait failed",
  }),
  close_agent: tool("Close", "agent", "action", {
    done: "Closed agent",
    running: "Closing agent",
    failed: "Close failed",
  }),
  send_input: tool("Send", "send", "action", {
    done: "Sent input",
    running: "Sending input",
    failed: "Send failed",
  }),
  update_knowledge: tool("Knowledge", "sparkles", "action", {
    done: "Updated knowledge",
    running: "Updating knowledge",
    failed: "Knowledge update failed",
  }),
  search_knowledge: tool("Knowledge", "search", "context", {
    done: "Searched knowledge",
    running: "Searching knowledge",
    failed: "Knowledge search failed",
  }),
  taskwrite: tool("Task", "checklist", "action", {
    done: "Updated tasks",
    running: "Updating tasks",
    failed: "Task update failed",
  }),
  taskcreate: tool("Task", "checklist", "action", {
    done: "Created task",
    running: "Creating task",
    failed: "Task creation failed",
  }),
  taskupdate: tool("Task", "checklist", "action", {
    done: "Updated task",
    running: "Updating task",
    failed: "Task update failed",
  }),
  taskget: tool("Task", "checklist", "context", {
    done: "Read task",
    running: "Reading task",
    failed: "Task read failed",
  }),
  tasklist: tool("Tasks", "list", "context", {
    done: "Listed tasks",
    running: "Listing tasks",
    failed: "Task list failed",
  }),
};

export function getToolInfo(toolName: string): ToolInfo {
  const normalized = normalizeToolName(toolName);
  return (
    TOOL_MAP[normalized] ??
    tool(toolName, "settings", "action", {
      done: toolName,
      running: `Running ${toolName}`,
      failed: `${toolName} failed`,
    })
  );
}

export function getToolActivityLabel(toolName: string, status: "streaming" | "done", isError: boolean): string {
  const info = getToolInfo(toolName);
  if (isError) return info.activity.failed;
  return status === "streaming" ? info.activity.running : info.activity.done;
}

export function formatToolDurationMs(durationMs?: number): string | null {
  if (durationMs === undefined || Number.isNaN(durationMs) || durationMs < 0) return null;
  return `${Math.round(durationMs)}ms`;
}

export function parseRequestUserInputTitle(parsed: Record<string, unknown>): string | undefined {
  const questions = parsed.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = questions[0];
  if (!first || typeof first !== "object") return undefined;
  const firstQuestion = first as Record<string, unknown>;
  const question = firstQuestion.question;
  if (typeof question === "string" && question.trim().length > 0) return question.trim();
  const header = firstQuestion.header;
  if (typeof header === "string" && header.trim().length > 0) return header.trim();
  return undefined;
}

export function parseRequestUserInputTitleFromOutput(outputText: string): string | undefined {
  const firstLine = outputText.split("\n")[0]?.trim();
  if (!firstLine) return undefined;
  const lineMatch = firstLine.match(/^\[[^\]]+\]\s*(.+)$/);
  if (lineMatch?.[1]?.trim()) return lineMatch[1].trim();
  const headerMatch = firstLine.match(/^\[([^\]]+)\]/);
  return headerMatch?.[1]?.trim();
}

export function getToolHeaderTitle(toolName: string, renderPayload?: ToolRenderPayload): string {
  const { displayName } = getToolInfo(toolName);
  const inputSummary = renderPayload?.inputSummary?.trim();
  return inputSummary ? `${displayName} - ${inputSummary}` : displayName;
}

export function isContextTool(toolName: string): boolean {
  return getToolInfo(toolName).category === "context";
}

export function isBashTool(toolName: string): boolean {
  return normalizeToolName(toolName) === "bash";
}

export function summarizeOutput(renderPayload?: ToolRenderPayload): string {
  return renderPayload?.outputSummary?.trim() ?? "";
}

export function summarizeInput(renderPayload?: ToolRenderPayload): string {
  return renderPayload?.inputSummary?.trim() ?? "";
}
