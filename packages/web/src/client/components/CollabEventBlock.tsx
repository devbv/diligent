// @summary Collab event block showing sub-agent orchestration in concise conversation order

import type { ThreadReadResponse, ToolRenderPayload } from "@diligent/protocol";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../lib/cn";
import type { RenderItem } from "../lib/thread-store";
import { stringifyUnknown } from "../lib/thread-utils";
import type { ToolIconName } from "../lib/tool-info";
import { ToolActivityRow } from "./ToolActivityRow";
import { ToolBlock } from "./ToolBlock";

interface CollabEventBlockProps {
  item: Extract<RenderItem, { kind: "collab" }>;
  loadChildThread?: (childThreadId: string) => Promise<ThreadReadResponse>;
  initialOpen?: boolean;
}

type ChildPreview = {
  childTools: Extract<RenderItem, { kind: "collab" }>["childTools"];
  childMessages: string[];
  childTimeline: NonNullable<Extract<RenderItem, { kind: "collab" }>["childTimeline"]>;
};

type CollabTimelineEntry = ChildPreview["childTimeline"][number];
type CollabTimelineToolEntry = Extract<CollabTimelineEntry, { kind: "tool" }>;

type CachedCollabViewState = {
  open: boolean;
  loadedChildPreview: ChildPreview | null;
};

const collabViewStateCache = new Map<string, CachedCollabViewState>();

export function deriveChildPreview(payload: ThreadReadResponse): ChildPreview {
  const childMessages: string[] = [];
  const childTimeline: ChildPreview["childTimeline"] = [];
  const childToolsByCallId = new Map<string, ChildPreview["childTools"][number]>();
  const childToolOrder: string[] = [];

  for (const item of payload.items) {
    if (item.type === "agentMessage") {
      const raw = stringifyUnknown(item.message);
      childMessages.push(raw);
      childTimeline.push({ kind: "assistant", message: raw });
      continue;
    }

    if (item.type === "toolCall") {
      const inputText = stringifyUnknown(item.input);
      const outputText = typeof item.output === "string" ? item.output : stringifyUnknown(item.output);
      const status = typeof item.output === "undefined" ? "running" : "done";
      const tool = {
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        status,
        isError: item.isError ?? false,
        inputText,
        outputText,
      } as const;
      if (!childToolsByCallId.has(item.toolCallId)) {
        childToolOrder.push(item.toolCallId);
      }
      childToolsByCallId.set(item.toolCallId, tool);
    }
  }

  for (const toolCallId of childToolOrder) {
    const tool = childToolsByCallId.get(toolCallId);
    if (!tool) continue;
    childTimeline.push({ ...tool, kind: "tool" });
  }

  return {
    childTools: childToolOrder.flatMap((toolCallId) => {
      const tool = childToolsByCallId.get(toolCallId);
      return tool ? [tool] : [];
    }),
    childMessages,
    childTimeline,
  };
}

export function resolveEffectiveTimeline(
  itemTimeline: Extract<RenderItem, { kind: "collab" }>["childTimeline"] | undefined,
  loadedChildPreview: ChildPreview | null,
): NonNullable<Extract<RenderItem, { kind: "collab" }>["childTimeline"]> {
  if (itemTimeline && itemTimeline.length > 0) {
    return itemTimeline;
  }
  return loadedChildPreview?.childTimeline ?? [];
}

function agentLabel(nickname?: string, threadId?: string): string {
  return nickname ?? threadId ?? "agent";
}

function formatAgentType(agentType?: string): string | null {
  if (!agentType) return null;
  return `[${agentType}]`;
}

function statusBadge(status?: string): { text: string; className: string } | null {
  switch (status) {
    case "completed":
      return { text: "completed", className: "text-success" };
    case "errored":
      // Recoverable from the parent agent's perspective (it observes the sub-agent
      // failure and decides how to proceed) — muted/gray, like the tool "error" label.
      // A genuine data-load failure (below) stays red.
      return { text: "error", className: "text-muted" };
    case "running":
      return { text: "running", className: "text-accent" };
    case "shutdown":
      return { text: "shutdown", className: "text-muted" };
    default:
      return null;
  }
}

function statusMeta(status?: string): { text: string; tone: "muted" | "success" | "danger" | "info" } | null {
  switch (status) {
    case "completed":
      return { text: "completed", tone: "success" };
    case "shutdown":
      return { text: "shutdown", tone: "muted" };
    default:
      return null;
  }
}

function collabIcon(eventType: Extract<RenderItem, { kind: "collab" }>["eventType"]): ToolIconName {
  switch (eventType) {
    case "wait":
      return "clock";
    case "close":
      return "agent";
    case "interaction":
      return "send";
    default:
      return "agent";
  }
}

function truncateUnicode(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars).join("")}…`;
}

function cleanTimelineText(value: string, maxChars: number): string {
  const cleaned = value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return truncateUnicode(cleaned, maxChars);
}

function summarizeRequest(inputText: string): string {
  const trimmed = inputText.trim();
  if (!trimmed) return "(empty request)";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const entries = Object.entries(parsed);
    if (entries.length === 0) return "{}";
    const preview = entries
      .slice(0, 3)
      .map(([key, value]) => {
        if (typeof value === "string") return `${key}=${value}`;
        if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`;
        if (Array.isArray(value)) return `${key}=[${value.length}]`;
        if (value && typeof value === "object") return `${key}={...}`;
        return key;
      })
      .join(", ");
    return truncateUnicode(preview, 180);
  } catch {
    return truncateUnicode(trimmed.split("\n")[0] ?? trimmed, 180);
  }
}

function summarizeResponse(outputText: string): string {
  const trimmed = outputText.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return "";
  return cleanTimelineText(trimmed.split("\n")[0] ?? trimmed, 180);
}

function summarizeAssistantMessage(rawMessage: string): string | null {
  const trimmed = typeof rawMessage === "string" ? rawMessage.trim() : "";
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
    };
    const blocks = parsed.content;
    if (!Array.isArray(blocks)) return cleanTimelineText(trimmed, 260);

    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!.trim())
      .filter((part) => part.length > 0)
      .join(" ");
    if (text) return cleanTimelineText(text, 260);

    const thinking = blocks
      .filter((block) => block.type === "thinking" && typeof block.thinking === "string")
      .map((block) => block.thinking!.trim())
      .filter((part) => part.length > 0)
      .join(" ");
    if (thinking) return cleanTimelineText(thinking, 200);

    return null;
  } catch {
    return cleanTimelineText(trimmed, 260);
  }
}

function buildChildToolRender(entry: CollabTimelineToolEntry): ToolRenderPayload {
  const inputSummary = summarizeRequest(entry.inputText);
  const outputSummary = summarizeResponse(entry.outputText);
  const blocks: ToolRenderPayload["blocks"] = [];

  if (outputSummary) {
    blocks.push({
      type: "text",
      title: "Output",
      text: entry.outputText.trim(),
      isError: entry.isError,
    });
  }

  return {
    inputSummary,
    ...(outputSummary ? { outputSummary } : {}),
    blocks,
  };
}

function buildChildToolItem(
  ownerId: string,
  entry: CollabTimelineToolEntry,
  index: number,
): Extract<RenderItem, { kind: "tool" }> {
  return {
    id: `${ownerId}:timeline:tool:${entry.toolCallId || index}`,
    kind: "tool",
    toolName: entry.toolName,
    inputText: entry.inputText,
    outputText: entry.outputText,
    isError: entry.isError,
    status: entry.status === "running" ? "streaming" : "done",
    timestamp: 0,
    toolCallId: entry.toolCallId || `${ownerId}:timeline:tool:${index}`,
    startedAt: 0,
    render: buildChildToolRender(entry),
  };
}

function CollabAssistantTimelineRow({ message }: { message: string }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeAssistantMessage(message);
  if (!summary) return null;

  const title = `Thought: ${truncateUnicode(summary, 140)}`;
  const hasDetail = Array.from(summary).length > 140;

  return (
    <ToolActivityRow
      title={title}
      detail={hasDetail ? summary : undefined}
      icon="sparkles"
      category="context"
      isError={false}
      isBusy={false}
      expanded={open}
      expandable={hasDetail}
      compact={true}
      onToggle={() => setOpen((value) => !value)}
    />
  );
}

export function getCollabEventPersistenceKey(item: Extract<RenderItem, { kind: "collab" }>): string {
  if (item.eventType === "spawn" && item.childThreadId) {
    return `spawn:${item.childThreadId}`;
  }
  return item.id;
}

export function CollabEventBlock({ item, loadChildThread, initialOpen = false }: CollabEventBlockProps) {
  const persistenceKey = getCollabEventPersistenceKey(item);
  const cachedState = collabViewStateCache.get(persistenceKey);
  const [open, setOpen] = useState(cachedState?.open ?? initialOpen);
  const [isLoadingChild, setIsLoadingChild] = useState(false);
  const [childLoadError, setChildLoadError] = useState<string | null>(null);
  const [loadedChildPreview, setLoadedChildPreview] = useState<ChildPreview | null>(
    cachedState?.loadedChildPreview ?? null,
  );
  const hasRunningTool = item.childTools.some((tool) => tool.status === "running");
  const isWaitRunning = item.eventType === "wait" && item.status === "running";
  const isBusy = item.status === "running" || hasRunningTool || isWaitRunning;
  const isError = item.status === "errored";
  const meta = isBusy || isError ? null : statusMeta(item.status);
  const effectiveTimeline = resolveEffectiveTimeline(item.childTimeline, loadedChildPreview);

  let title = "";
  let details: string | null = null;
  const agentTypeLabel = item.eventType === "spawn" ? formatAgentType(item.agentType) : null;

  switch (item.eventType) {
    case "spawn":
      title = `Spawned ${agentLabel(item.nickname, item.childThreadId)}${agentTypeLabel ? ` ${agentTypeLabel}` : ""}`;
      details = item.description ?? null;
      break;
    case "wait": {
      const count = item.agents?.length ?? 0;
      if (item.status === "running") {
        title =
          count === 1 && item.agents?.[0]
            ? `Waiting for ${agentLabel(item.agents[0].nickname, item.agents[0].threadId)}`
            : `Waiting for ${count} agents`;
      } else {
        title =
          count === 1 && item.agents?.[0]
            ? `Finished waiting for ${agentLabel(item.agents[0].nickname, item.agents[0].threadId)}`
            : `Finished waiting for ${count} agents`;
      }
      break;
    }
    case "close":
      title = `Closed ${agentLabel(item.nickname, item.childThreadId)}`;
      break;
    case "interaction":
      title = `Sent message to ${agentLabel(item.nickname, item.childThreadId)}`;
      break;
  }

  const timeline = effectiveTimeline;
  const hasBody = Boolean(
    details ||
      item.message ||
      (item.eventType === "wait" && item.agents?.length) ||
      timeline.length > 0 ||
      (item.eventType === "spawn" && item.childThreadId),
  );
  const isInteractive = hasBody;

  function toggleOpen(): void {
    if (!isInteractive) return;
    setOpen((value) => !value);
  }

  const loadChildDetail = useCallback(async (): Promise<void> => {
    if (item.eventType !== "spawn" || !item.childThreadId || !loadChildThread) return;
    if (isLoadingChild) return;
    if (loadedChildPreview) return;
    setIsLoadingChild(true);
    setChildLoadError(null);
    try {
      const child = await loadChildThread(item.childThreadId);
      setLoadedChildPreview(deriveChildPreview(child));
    } catch (error) {
      setChildLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingChild(false);
    }
  }, [item.eventType, item.childThreadId, loadChildThread, isLoadingChild, loadedChildPreview]);

  const retryLoadChildDetail = useCallback(async (): Promise<void> => {
    setLoadedChildPreview(null);
    await loadChildDetail();
  }, [loadChildDetail]);

  useEffect(() => {
    collabViewStateCache.set(persistenceKey, { open, loadedChildPreview });
  }, [persistenceKey, open, loadedChildPreview]);

  useEffect(() => {
    if (!open) return;
    if (item.eventType !== "spawn" || !item.childThreadId) return;
    void loadChildDetail();
  }, [open, item.eventType, item.childThreadId, loadChildDetail]);

  return (
    <div className="pb-1">
      <ToolActivityRow
        title={title}
        icon={collabIcon(item.eventType)}
        category="action"
        isError={isError}
        isBusy={isBusy}
        metaLabel={meta?.text}
        metaTone={meta?.tone}
        expanded={open}
        expandable={isInteractive}
        compact={true}
        onToggle={toggleOpen}
      />

      {open ? (
        <div className="mt-1 max-w-tool-row space-y-1 text-xs">
          {details ? <p className="ml-7 text-sm leading-5 text-text-secondary">{details}</p> : null}

          {item.message ? (
            <p className="ml-7 text-xs leading-5 text-muted/80">{cleanTimelineText(item.message, 240)}</p>
          ) : null}

          {isWaitRunning ? (
            <div className="ml-7 flex h-6 items-center gap-2 text-xs text-accent/90">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent/25 border-t-accent"
              />
              <span>Subagents are still working…</span>
            </div>
          ) : null}

          {item.eventType === "wait" && item.agents?.length ? (
            <div className="ml-7 space-y-0.5">
              {item.agents.map((agent) => {
                const agentStatus = statusBadge(agent.status);
                return (
                  <div key={agent.threadId} className="min-w-0 truncate text-xs leading-5 text-text/60">
                    {agentLabel(agent.nickname, agent.threadId)}
                    {agentStatus ? <span className={cn("ml-2", agentStatus.className)}>{agentStatus.text}</span> : null}
                    {agent.message ? (
                      <span className="ml-2 text-text/45">- {cleanTimelineText(agent.message, 140)}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {timeline.length > 0 ? (
            <div className="ml-7 space-y-0.5">
              {timeline.map((entry, index) => {
                if (entry.kind === "assistant") {
                  return (
                    <CollabAssistantTimelineRow
                      key={`${item.id}:timeline:assistant:${index}`}
                      message={entry.message}
                    />
                  );
                }

                return (
                  <ToolBlock
                    key={`${item.id}:timeline:tool:${entry.toolCallId || index}`}
                    item={buildChildToolItem(item.id, entry, index)}
                    nested
                    inlinePreviewWhenCollapsed
                  />
                );
              })}
            </div>
          ) : null}

          {item.eventType === "spawn" && item.childThreadId ? (
            <div className="ml-7 pt-0.5 text-xs leading-5 text-text/55">
              {isLoadingChild ? <div>Loading child thread details…</div> : null}
              {!isLoadingChild && childLoadError ? (
                <div className="space-y-1">
                  <div className="text-danger/80">Failed to load child thread detail: {childLoadError}</div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void retryLoadChildDetail();
                    }}
                    className="text-2xs text-accent hover:underline"
                  >
                    Retry
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
