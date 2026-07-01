// @summary Collab event block showing sub-agent orchestration in concise conversation order

import type { ThreadReadResponse } from "@diligent/protocol";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../lib/cn";
import type { RenderItem } from "../lib/thread-store";
import { stringifyUnknown } from "../lib/thread-utils";
import { getToolInfo } from "../lib/tool-info";
import { StatusDot } from "./StatusDot";

interface CollabEventBlockProps {
  item: Extract<RenderItem, { kind: "collab" }>;
  loadChildThread?: (childThreadId: string) => Promise<ThreadReadResponse>;
}

type ChildPreview = {
  childTools: Extract<RenderItem, { kind: "collab" }>["childTools"];
  childMessages: string[];
  childTimeline: NonNullable<Extract<RenderItem, { kind: "collab" }>["childTimeline"]>;
};

type CachedCollabViewState = {
  open: boolean;
  loadedChildPreview: ChildPreview | null;
};

const collabViewStateCache = new Map<string, CachedCollabViewState>();

function deriveChildPreview(payload: ThreadReadResponse): ChildPreview {
  const childTools: ChildPreview["childTools"] = [];
  const childMessages: string[] = [];
  const childTimeline: ChildPreview["childTimeline"] = [];

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
      childTools.push(tool);
      childTimeline.push({ ...tool, kind: "tool" });
    }
  }

  return {
    childTools,
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

function truncateUnicode(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars).join("")}…`;
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
  if (!trimmed) return "(empty response)";
  return truncateUnicode(trimmed.split("\n")[0] ?? trimmed, 180);
}

function summarizeAssistantMessage(rawMessage: string): string | null {
  const trimmed = typeof rawMessage === "string" ? rawMessage.trim() : "";
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
    };
    const blocks = parsed.content;
    if (!Array.isArray(blocks)) return truncateUnicode(trimmed, 260);

    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!.trim())
      .filter((part) => part.length > 0)
      .join(" ");
    if (text) return truncateUnicode(text, 260);

    const thinking = blocks
      .filter((block) => block.type === "thinking" && typeof block.thinking === "string")
      .map((block) => block.thinking!.trim())
      .filter((part) => part.length > 0)
      .join(" ");
    if (thinking) return truncateUnicode(thinking, 200);

    return null;
  } catch {
    return truncateUnicode(trimmed, 260);
  }
}

export function getCollabEventPersistenceKey(item: Extract<RenderItem, { kind: "collab" }>): string {
  if (item.eventType === "spawn" && item.childThreadId) {
    return `spawn:${item.childThreadId}`;
  }
  return item.id;
}

export function CollabEventBlock({ item, loadChildThread }: CollabEventBlockProps) {
  const persistenceKey = getCollabEventPersistenceKey(item);
  const cachedState = collabViewStateCache.get(persistenceKey);
  const [open, setOpen] = useState(cachedState?.open ?? false);
  const [isLoadingChild, setIsLoadingChild] = useState(false);
  const [childLoadError, setChildLoadError] = useState<string | null>(null);
  const [loadedChildPreview, setLoadedChildPreview] = useState<ChildPreview | null>(
    cachedState?.loadedChildPreview ?? null,
  );
  const hasRunningTool = item.childTools.some((tool) => tool.status === "running");
  const isWaitRunning = item.eventType === "wait" && item.status === "running";
  const badge = statusBadge(item.status);
  const turnInfo = item.eventType === "spawn" && item.turnNumber ? `turn ${item.turnNumber}` : null;
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
    <div className="pb-4">
      <div
        role={isInteractive ? "button" : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        onClick={
          isInteractive
            ? (event) => {
                const target = event.target;
                if (target instanceof Element && target.closest("button, a, input, textarea, select")) {
                  return;
                }
                toggleOpen();
              }
            : undefined
        }
        onKeyDown={
          isInteractive
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                toggleOpen();
              }
            : undefined
        }
        className={cn(
          "min-w-0 rounded-lg bg-surface-dark py-2.5",
          isInteractive ? "cursor-pointer transition hover:bg-surface-dark/80 focus:outline-none" : null,
        )}
      >
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {isWaitRunning ? (
              <span
                aria-hidden="true"
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/30 border-t-accent"
              />
            ) : null}
            <span className="text-sm font-medium text-text-soft">{title}</span>
            {badge && <span className={cn("text-xs", badge.className)}>{badge.text}</span>}
            {hasRunningTool && <StatusDot color="accent" pulse />}
            {turnInfo && <span className="text-xs text-text/40">{turnInfo}</span>}
          </div>

          {open ? (
            <>
              {details ? <p className="text-xs leading-5 text-text/60">{details}</p> : null}

              {item.message ? <p className="text-xs text-text/65">{truncateUnicode(item.message, 240)}</p> : null}

              {isWaitRunning ? (
                <div className="flex items-center gap-2 text-xs text-accent/90">
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent/25 border-t-accent"
                  />
                  <span>Subagents are still working…</span>
                </div>
              ) : null}

              {item.eventType === "wait" && item.agents?.length ? (
                <div className="space-y-1">
                  {item.agents.map((agent) => {
                    const agentStatus = statusBadge(agent.status);
                    return (
                      <div key={agent.threadId} className="text-xs text-text/60">
                        {agentLabel(agent.nickname, agent.threadId)}
                        {agentStatus ? (
                          <span className={cn("ml-2", agentStatus.className)}>{agentStatus.text}</span>
                        ) : null}
                        {agent.message ? (
                          <span className="ml-2 text-text/45">- {truncateUnicode(agent.message, 140)}</span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {timeline.length > 0 ? (
                <div className="space-y-1 text-xs">
                  {timeline.map((entry, index) => {
                    if (entry.kind === "assistant") {
                      const summary = summarizeAssistantMessage(entry.message);
                      if (!summary) return null;
                      return (
                        <div key={`${item.id}:timeline:assistant:${index}`} className="text-text/70">
                          {summary}
                        </div>
                      );
                    }

                    const info = getToolInfo(entry.toolName);
                    const req = summarizeRequest(entry.inputText);
                    const res = summarizeResponse(entry.outputText);
                    return (
                      <div key={`${item.id}:timeline:tool:${entry.toolCallId}`} className="font-mono">
                        <div className="text-text/60">
                          {info.displayName} - {req}
                        </div>
                        <div className="text-text/45">ㄴ {res}</div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {item.eventType === "spawn" && item.childThreadId ? (
                <div className="pt-1 text-xs text-text/55">
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
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
