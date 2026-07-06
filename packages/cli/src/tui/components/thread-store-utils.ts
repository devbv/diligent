// @summary Utility helpers for ThreadStore parsing, formatting, and reducer item construction

import type {
  AgentEvent,
  AssistantMessage,
  TextBlock,
  ThreadReadResponse,
  ToolRenderPayload,
} from "@diligent/protocol";
import { COLLAB_TOOL_NAMES, normalizeToolName, ToolRenderPayloadSchema } from "@diligent/protocol";
import { renderToolPayload } from "../render-blocks";
import { t } from "../theme";
import type { ThreadItem, ToolResultThreadItem } from "./thread-store-primitives";

export { COLLAB_TOOL_NAMES, normalizeToolName };
export const TOOL_MAX_LINES = 5;

export interface ToolCallState {
  startedAt: number;
  input?: unknown;
  startRender?: ToolRenderPayload;
}

export interface CollabToolState {
  toolName: string;
  label: string;
  prompt?: string;
}

export function formatTokensRoundedK(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

export function formatElapsedSeconds(ms: number): string | null {
  if (ms < 1000) return null;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function getWorkingSpinnerFrame(nowMs: number): string {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const frameIndex = Math.floor(nowMs / 120) % frames.length;
  return frames[frameIndex] ?? "⠋";
}

export function parseCollabOutput(output: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(output);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export function summarizeCollabLine(value: string, maxChars: number): string {
  const firstLine = value.split("\n")[0] ?? value;
  const chars = Array.from(firstLine);
  if (chars.length <= maxChars) return firstLine;
  return `${chars.slice(0, maxChars).join("")}…`;
}

function summarizeChildText(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  const chars = Array.from(singleLine);
  if (chars.length <= maxChars) return singleLine;
  return `${chars.slice(0, maxChars).join("")}…`;
}

export function parseSpawnChildThreadId(output: string): string | undefined {
  const parsed = parseCollabOutput(output);
  const threadId = parsed?.thread_id;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId : undefined;
}

export function buildChildDetailLines(payload: ThreadReadResponse): string[] {
  const detailLines: string[] = [];
  let assistantCount = 0;
  let toolCount = 0;

  for (const item of payload.items) {
    if (item.type === "agentMessage") {
      const text = item.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ");
      const summary = summarizeChildText(text, 140);
      if (summary) {
        assistantCount++;
        detailLines.push(`${t.dim}    assistant: ${summary}${t.reset}`);
      }
      continue;
    }

    if (item.type === "toolCall") {
      toolCount++;
      const status = item.isError ? "error" : typeof item.output === "undefined" ? "running" : "done";
      detailLines.push(`${t.dim}    tool: ${item.toolName} (${status})${t.reset}`);
      if (typeof item.output === "string") {
        const outputPreview = summarizeCollabLine(item.output, 120);
        if (outputPreview) {
          detailLines.push(`${t.dim}      ↳ ${outputPreview}${t.reset}`);
        }
      }
    }
  }

  const previewLimit = 12;
  const previewLines = detailLines.slice(0, previewLimit);
  const omitted = detailLines.length - previewLines.length;
  if (omitted > 0) {
    previewLines.push(`${t.dim}    … +${omitted} more lines${t.reset}`);
  }

  return [
    `${t.dim}  Child thread preview:${t.reset}`,
    `${t.dim}    assistant=${assistantCount}, tools=${toolCount}${t.reset}`,
    ...previewLines,
  ];
}

function summarizeProviderToolInput(input: Record<string, unknown>): string | undefined {
  const type = typeof input.type === "string" ? input.type : undefined;
  if (type === "search") {
    const query = typeof input.query === "string" ? input.query : undefined;
    return query ? `Searched ${query}` : "Searching the web";
  }
  if (type === "open_page") {
    const url = typeof input.url === "string" ? input.url : undefined;
    return url ? `Opened ${url}` : "Opening page";
  }
  if (type === "find_in_page") {
    const url = typeof input.url === "string" ? input.url : undefined;
    const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
    if (url && pattern) return `Found “${pattern}” in ${url}`;
    if (url) return `Opened ${url}`;
    if (pattern) return `Finding “${pattern}” in page`;
    return "Finding in page";
  }
  return type;
}

function buildProviderToolItem(summary: string, details: string[] = []): ToolResultThreadItem {
  const header = `${t.success}⏺${t.reset} Web Action`;
  return createToolResultItem([header, ...details], `⎿  ${summary}`);
}

export function renderAssistantStructuredItems(
  message: Pick<AssistantMessage, "content"> | { content?: AssistantMessage["content"] },
): ThreadItem[] {
  if (!Array.isArray(message.content)) {
    return [];
  }

  const items: ThreadItem[] = [];
  const textCitations: TextCitation[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case "provider_tool_use": {
        const summary = summarizeProviderToolInput(block.input) ?? "Searching the web";
        items.push(buildProviderToolItem(summary));
        break;
      }
      case "web_search_result": {
        if (block.error) {
          const message = block.error.message ? `${block.error.code}: ${block.error.message}` : block.error.code;
          items.push(buildProviderToolItem("Web search failed", [`${t.error}  ${message}${t.reset}`]));
          break;
        }

        const summary = `Found ${block.results.length} result${block.results.length === 1 ? "" : "s"}`;
        const details: string[] = [];
        if (block.results.length > 0) {
          details.push(
            `${t.dim}  Found ${block.results.length} result${block.results.length === 1 ? "" : "s"}${t.reset}`,
          );
        }
        for (const result of block.results.slice(0, 5)) {
          const title = result.title?.trim() || result.url;
          details.push(`${t.dim}  • ${title}${t.reset}`);
          if (result.url && result.url !== title) {
            details.push(`${t.dim}    ${result.url}${t.reset}`);
          }
        }
        if (block.results.length > 5) {
          details.push(`${t.dim}  … +${block.results.length - 5} more results${t.reset}`);
        }
        items.push(buildProviderToolItem(summary, details));
        break;
      }
      case "web_fetch_result": {
        if (block.error) {
          const message = block.error.message ? `${block.error.code}: ${block.error.message}` : block.error.code;
          items.push(buildProviderToolItem("Opening page failed", [`${t.error}  ${message}${t.reset}`]));
          break;
        }

        const summary = `Opened ${block.document?.title ?? block.url}`;
        const details: string[] = [`${t.dim}  ${block.url}${t.reset}`];
        if (block.document?.mimeType) {
          details.push(`${t.dim}  type: ${block.document.mimeType}${t.reset}`);
        }
        items.push(buildProviderToolItem(summary, details));
        break;
      }
      case "text": {
        textCitations.push(...(block.citations ?? []));
        break;
      }
      default:
        break;
    }
  }

  const citationLines = renderTextCitations(dedupeTextCitations(textCitations));
  if (citationLines.length > 0) {
    items.push({ kind: "plain", lines: citationLines });
  }

  return items;
}

type TextCitation = NonNullable<TextBlock["citations"]>[number];

export function dedupeTextCitations(citations: TextCitation[]): TextCitation[] {
  const seen = new Set<string>();
  const deduped: TextCitation[] = [];
  for (const citation of citations) {
    const key =
      citation.type === "web_search_result_location"
        ? `web:${citation.url}`
        : `doc:${citation.documentIndex}:${citation.startCharIndex}-${citation.endCharIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(citation);
  }
  return deduped;
}

function renderTextCitations(citations: TextCitation[]): string[] {
  if (citations.length === 0) return [];
  const lines: string[] = [];
  for (const citation of citations.slice(0, 5)) {
    if (citation.type === "web_search_result_location") {
      const label = citation.title?.trim() || citation.url;
      lines.push(`${t.dim}[source] ${label}${citation.url !== label ? ` — ${citation.url}` : ""}${t.reset}`);
      continue;
    }
    const title = citation.documentTitle?.trim() || `document ${citation.documentIndex}`;
    lines.push(`${t.dim}[source] ${title} chars ${citation.startCharIndex}-${citation.endCharIndex}${t.reset}`);
  }
  if (citations.length > 5) {
    lines.push(`${t.dim}[source] … +${citations.length - 5} more citations${t.reset}`);
  }
  return lines;
}

export function renderAssistantMessageBlocks(
  message: Pick<AssistantMessage, "content"> | { content?: AssistantMessage["content"] },
): { thinking: string; text: string; extras: string[] } {
  const thinkingParts: string[] = [];
  const textParts: string[] = [];
  const extras: string[] = [];
  const textCitations: TextCitation[] = [];

  if (!Array.isArray(message.content)) {
    return { thinking: "", text: "", extras };
  }

  for (const block of message.content) {
    switch (block.type) {
      case "thinking":
        thinkingParts.push(block.thinking);
        break;
      case "text":
        textParts.push(block.text);
        textCitations.push(...(block.citations ?? []));
        break;
      default:
        break;
    }
  }

  extras.push(...renderTextCitations(dedupeTextCitations(textCitations)));

  return {
    thinking: thinkingParts.join(""),
    text: textParts.join(""),
    extras,
  };
}

export function isChildScopedStreamEvent(event: AgentEvent): boolean {
  switch (event.type) {
    case "message_start":
    case "message_discarded":
    case "message_delta":
    case "message_end":
    case "tool_start":
    case "tool_update":
    case "tool_end":
      return "childThreadId" in event && typeof event.childThreadId === "string";
    default:
      return false;
  }
}

export function truncateMiddle(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  const head = Math.floor((max - 1) / 2);
  const tail = max - head - 1;
  const omitted = lines.length - head - tail;
  return [...lines.slice(0, head), `… +${omitted} lines`, ...lines.slice(lines.length - tail)];
}

export function buildToolHeader(toolName: string, payload?: ToolRenderPayload): string {
  const inputSummary = payload?.inputSummary?.trim();
  return inputSummary ? `${toolName} - ${inputSummary}` : toolName;
}

export function buildToolSummaryLine(payload?: ToolRenderPayload): string | undefined {
  const outputSummary = payload?.outputSummary?.trim();
  return outputSummary ? `⎿  ${outputSummary}` : undefined;
}

export function toProtocolRenderPayload(value: unknown): ToolRenderPayload | undefined {
  const parsed = ToolRenderPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function mergeToolRenderPayload(
  started: ToolRenderPayload | undefined,
  completed: ToolRenderPayload | undefined,
): ToolRenderPayload | undefined {
  if (!started) return completed;
  if (!completed) return started;
  return {
    ...completed,
    inputSummary: completed.inputSummary ?? started.inputSummary,
  };
}

export function splitThoughtLines(text: string): string[] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function createToolResultItem(lines: string[], summaryLine?: string): ToolResultThreadItem {
  if (lines.length === 0) {
    return { kind: "tool_result", header: "", summaryLine, details: [] };
  }
  return {
    kind: "tool_result",
    header: lines[0],
    summaryLine,
    details: lines.slice(1),
  };
}

export function buildThinkingItem(text: string, elapsedMs?: number): ThreadItem {
  const icon = `${t.success}⏺${t.reset}`;
  const header =
    elapsedMs !== undefined
      ? `${icon} ${t.bold}Thought for ${formatElapsedSeconds(elapsedMs) ?? "0s"}${t.reset}`
      : `${icon} ${t.bold}Thought${t.reset}`;
  return { kind: "thinking", header, bodyLines: splitThoughtLines(text) };
}

export function deriveToolStartState(
  event: Extract<AgentEvent, { type: "tool_start" }>,
  options: { planCallCount: number; collabAgentNamesByThreadId: Record<string, string> },
): { overlayMessage: string; collabState?: CollabToolState } {
  const toolName = normalizeToolName(event.toolName);
  if (toolName === "plan") {
    return { overlayMessage: options.planCallCount === 0 ? "Planning…" : "Updating plan…" };
  }

  if (!COLLAB_TOOL_NAMES.has(toolName)) {
    return { overlayMessage: event.toolName };
  }

  const input = event.input as Record<string, unknown> | null;
  let spinnerLabel = event.toolName;
  let prompt: string | undefined;
  if (toolName === "spawn_agent") {
    const agentType = (input?.agent_type as string | undefined) ?? "general";
    const description = (input?.description as string | undefined) ?? "";
    const promptText = typeof input?.message === "string" ? input.message : "";
    const promptSummary = promptText
      ? promptText.split("\n")[0].trim().slice(0, 72) + (promptText.length > 72 ? "…" : "")
      : "";
    spinnerLabel = description
      ? `Spawning [${agentType}] ${description}…`
      : promptSummary
        ? `Spawning [${agentType}] ${promptSummary}`
        : `Spawning [${agentType}]…`;
    prompt = promptText || undefined;
  } else if (toolName === "wait") {
    const ids = input?.ids;
    if (Array.isArray(ids) && ids.length > 0) {
      const labels = ids.map((id) => {
        if (typeof id !== "string") return String(id);
        return options.collabAgentNamesByThreadId[id] ?? id;
      });
      spinnerLabel = `Waiting for ${labels.join(", ")}…`;
    } else {
      spinnerLabel = "Waiting for agents…";
    }
  } else if (toolName === "send_input") {
    const targetId = input?.id as string | undefined;
    spinnerLabel = `Sending to ${
      (targetId ? options.collabAgentNamesByThreadId[targetId] : undefined) ?? targetId ?? "agent"
    }…`;
  } else if (toolName === "close_agent") {
    const targetId = input?.id as string | undefined;
    spinnerLabel = `Closing ${
      (targetId ? options.collabAgentNamesByThreadId[targetId] : undefined) ?? targetId ?? "agent"
    }…`;
  }

  return {
    overlayMessage: spinnerLabel,
    collabState: { toolName: event.toolName, label: spinnerLabel, prompt },
  };
}

export function deriveToolUpdateMessage(
  event: Extract<AgentEvent, { type: "tool_update" }>,
  collabState?: CollabToolState,
): string {
  if (COLLAB_TOOL_NAMES.has(normalizeToolName(event.toolName)) && collabState) {
    return `${collabState.label} — ${event.partialResult}`;
  }
  return `${event.toolName}…`;
}

export function buildToolEndItem(options: {
  event: Extract<AgentEvent, { type: "tool_end" }>;
  toolCall?: ToolCallState;
  collabState?: CollabToolState;
  planCallCount: number;
  collabAgentNamesByThreadId: Record<string, string>;
  nowMs: number;
}): { item: ThreadItem; collabAgentNamesByThreadId: Record<string, string>; planCallCount: number } {
  const { event, toolCall, collabState, planCallCount, collabAgentNamesByThreadId, nowMs } = options;
  const toolName = normalizeToolName(event.toolName);
  const elapsedVal = toolCall ? formatElapsedSeconds(nowMs - toolCall.startedAt) : null;
  const elapsed = elapsedVal ? ` ${t.dim}· ${elapsedVal}${t.reset}` : "";
  const icon = event.isError ? `${t.error}✗${t.reset}` : `${t.success}⏺${t.reset}`;
  const renderPayload: ToolRenderPayload | undefined = mergeToolRenderPayload(
    toolCall?.startRender,
    toProtocolRenderPayload(event.render),
  );

  if (toolName === "plan") {
    const nextPlanCallCount = planCallCount + 1;
    const parsed = parseCollabOutput(event.output);
    const isUpdate = nextPlanCallCount > 1;
    const header = isUpdate ? "Updated Plan" : ((parsed?.title as string | undefined) ?? "Plan");
    const lines: string[] = [`${icon} ${t.bold}${header}${t.reset}${elapsed}`];
    if (parsed?.steps && Array.isArray(parsed.steps)) {
      for (const step of parsed.steps as Array<{
        text: string;
        status?: "pending" | "in_progress" | "done";
        done?: boolean;
      }>) {
        const status = step.status ?? (step.done ? "done" : "pending");
        const check =
          status === "done" ? `${t.success}☑${t.reset}` : status === "in_progress" ? "▶" : `${t.dim}☐${t.reset}`;
        const text = status === "done" ? `${t.dim}${step.text}${t.reset}` : step.text;
        lines.push(`  ${check} ${text}`);
      }
    }
    return {
      item: { kind: "plain", lines },
      collabAgentNamesByThreadId,
      planCallCount: nextPlanCallCount,
    };
  }

  if (toolName === "skill") {
    const match = event.output.match(/<skill_content\s+name="([^"]+)"/);
    const skillName = match?.[1];
    const label = skillName ? `Loaded skill: ${skillName}` : "Loaded skill";
    return {
      item: { kind: "plain", lines: [`${icon} ${label}${elapsed}`] },
      collabAgentNamesByThreadId,
      planCallCount,
    };
  }

  if (COLLAB_TOOL_NAMES.has(toolName)) {
    const parsed = parseCollabOutput(event.output);
    const lines: string[] = [];
    const nextNames = { ...collabAgentNamesByThreadId };

    if (toolName === "spawn_agent") {
      const nickname = (parsed?.nickname as string | undefined) ?? "agent";
      const inputLabel = collabState?.label ?? "";
      const typeMatch = inputLabel.match(/\[([^\]]+)\]/);
      const agentType = typeMatch ? typeMatch[1] : "general";
      lines.push(`${icon} Spawned ${t.bold}${nickname}${t.reset} [${agentType}]${elapsed}`);
      const prompt = collabState?.prompt;
      if (typeof prompt === "string" && prompt.trim()) {
        const promptLines = truncateMiddle(prompt.trim().split("\n"), TOOL_MAX_LINES);
        for (let i = 0; i < promptLines.length; i++) {
          lines.push(`${t.dim}  ${i === 0 ? `prompt: ${promptLines[i]}` : promptLines[i]}${t.reset}`);
        }
      }
      const childThreadId = parseSpawnChildThreadId(event.output);
      const trimmedNickname = (parsed?.nickname as string | undefined)?.trim();
      const item = createToolResultItem(lines);
      if (childThreadId && trimmedNickname) {
        nextNames[childThreadId] = trimmedNickname;
      }
      if (childThreadId) {
        item.childDetail = { childThreadId, status: "idle" };
      }
      return { item, collabAgentNamesByThreadId: nextNames, planCallCount };
    }

    if (toolName === "wait") {
      lines.push(`${icon} Finished waiting${elapsed}`);
      if (parsed?.summary && Array.isArray(parsed.summary)) {
        for (const entry of parsed.summary as string[]) {
          lines.push(`${t.dim}  ${summarizeCollabLine(entry, 160)}${t.reset}`);
        }
      }
      if (parsed?.timed_out) {
        lines.push(`${t.warn}  Timed out${t.reset}`);
      }
      return { item: createToolResultItem(lines), collabAgentNamesByThreadId: nextNames, planCallCount };
    }

    if (toolName === "send_input") {
      const nickname = (parsed?.nickname as string | undefined) ?? "agent";
      lines.push(`${icon} Sent input → ${t.bold}${nickname}${t.reset}${elapsed}`);
      return { item: createToolResultItem(lines), collabAgentNamesByThreadId: nextNames, planCallCount };
    }

    if (toolName === "close_agent") {
      const nickname = (parsed?.nickname as string | undefined) ?? "agent";
      lines.push(`${icon} Closed ${t.bold}${nickname}${t.reset}${elapsed}`);
      return { item: createToolResultItem(lines), collabAgentNamesByThreadId: nextNames, planCallCount };
    }
  }

  if (renderPayload) {
    const headerLabel = buildToolHeader(event.toolName, renderPayload);
    const rendered = renderToolPayload(renderPayload);
    const lines: string[] = [`${icon} ${headerLabel}${elapsed}`];
    if (rendered.length > 0) {
      lines.push(...rendered.map((line) => `  ${line}`));
    }
    return {
      item: createToolResultItem(lines, buildToolSummaryLine(renderPayload)),
      collabAgentNamesByThreadId,
      planCallCount,
    };
  }

  if (event.output) {
    const headerLabel = buildToolHeader(event.toolName);
    const rawLines = event.output.split("\n");
    const display = truncateMiddle(rawLines, TOOL_MAX_LINES);
    const lines: string[] = [`${icon} ${headerLabel}${elapsed}`];
    for (const line of display) {
      lines.push(`${t.dim}  ${line}${t.reset}`);
    }
    return {
      item: createToolResultItem(lines),
      collabAgentNamesByThreadId,
      planCallCount,
    };
  }

  return {
    item: { kind: "plain", lines: [`${icon} ${buildToolHeader(event.toolName)}${elapsed}`] },
    collabAgentNamesByThreadId,
    planCallCount,
  };
}
