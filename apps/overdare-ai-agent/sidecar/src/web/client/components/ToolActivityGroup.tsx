// @summary Minimal grouped transcript row for consecutive tool activity items

import { useMemo, useState } from "react";
import type { RenderItem } from "../lib/thread-store";
import { normalizeToolName } from "../lib/thread-utils";
import { formatDurationLabel } from "../lib/time-format";
import { getToolActivityLabel, getToolInfo } from "../lib/tool-info";
import { ToolActivityRow } from "./ToolActivityRow";
import { ToolBlock } from "./ToolBlock";

type ToolItem = Extract<RenderItem, { kind: "tool" }>;

type GroupStatus = "streaming" | "done" | "failed";

function plural(count: number, singular: string, pluralName = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralName}`;
}

function failurePhrase(count: number, singular: string, pluralName = `${singular}s`): string {
  return count === 1 ? `${singular} failed` : `${plural(count, singular, pluralName)} failed`;
}

function toolGroupPhrase(toolName: string, count: number, status: GroupStatus): string {
  const normalized = normalizeToolName(toolName);
  const failed = status === "failed";
  const running = status === "streaming";
  switch (normalized) {
    case "read":
      if (failed) return failurePhrase(count, "read");
      return running ? `Reading ${plural(count, "file")}` : `Read ${plural(count, "file")}`;
    case "read_image":
      if (failed) return failurePhrase(count, "image read");
      return running ? `Reading ${plural(count, "image")}` : `Read ${plural(count, "image")}`;
    case "grep":
      if (failed) return failurePhrase(count, "search", "searches");
      return running
        ? count === 1
          ? "Searching code"
          : `Searching code ${count} times`
        : count === 1
          ? "Searched code"
          : `Searched code ${count} times`;
    case "glob":
      if (failed) return failurePhrase(count, "match", "matches");
      return running ? `Matching ${plural(count, "pattern")}` : `Matched ${plural(count, "pattern")}`;
    case "ls":
      if (failed) return failurePhrase(count, "list");
      return running
        ? `Listing ${plural(count, "directory", "directories")}`
        : `Listed ${plural(count, "directory", "directories")}`;
    case "bash":
      if (failed) return failurePhrase(count, "command");
      return running ? `Running ${plural(count, "command")}` : `Ran ${plural(count, "command")}`;
    case "write":
      if (failed) return failurePhrase(count, "write");
      return running ? `Writing ${plural(count, "file")}` : `Wrote ${plural(count, "file")}`;
    case "edit":
      if (failed) return failurePhrase(count, "edit");
      return running ? `Editing ${plural(count, "file")}` : `Edited ${plural(count, "file")}`;
    case "apply_patch":
    case "multi_edit":
    case "multiedit":
      if (failed) return failurePhrase(count, "edit");
      return running ? `Editing ${plural(count, "file")}` : `Edited ${plural(count, "file")}`;
    case "skill":
      if (failed) return failurePhrase(count, "skill load");
      return running ? `Loading ${plural(count, "skill")}` : `Loaded ${plural(count, "skill")}`;
    case "web_action":
    case "web_search":
      if (failed) return failurePhrase(count, "web search", "web searches");
      return running
        ? count === 1
          ? "Searching web"
          : `Searching web ${count} times`
        : count === 1
          ? "Searched web"
          : `Searched web ${count} times`;
    case "web_fetch":
      if (failed) return failurePhrase(count, "page open");
      return running
        ? count === 1
          ? "Opening page"
          : `Opening ${plural(count, "page")}`
        : count === 1
          ? "Opened page"
          : `Opened ${plural(count, "page")}`;
    case "overdaresearch":
      if (failed) return failurePhrase(count, "asset search", "asset searches");
      return running
        ? count === 1
          ? "Searching assets"
          : `Searching assets ${count} times`
        : count === 1
          ? "Searched assets"
          : `Searched assets ${count} times`;
    case "search_knowledge":
      if (failed) return failurePhrase(count, "knowledge search", "knowledge searches");
      return running ? "Searching knowledge" : "Searched knowledge";
    default: {
      const label = getToolActivityLabel(toolName, status === "streaming" ? "streaming" : "done", failed);
      return count === 1 ? label : `${label} ${count} times`;
    }
  }
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value[0].toLowerCase()}${value.slice(1)}`;
}

function joinPhrases(phrases: string[]): string {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${lowerFirst(phrases[1])}`;
  const firstPhrases = phrases.slice(0, -1).map((phrase, index) => (index === 0 ? phrase : lowerFirst(phrase)));
  return `${firstPhrases.join(", ")}, and ${lowerFirst(phrases[phrases.length - 1])}`;
}

function summarizeToolGroup(items: ToolItem[]): string {
  if (items.length > 1 && items.every((item) => item.isError)) {
    const normalizedNames = new Set(items.map((item) => normalizeToolName(item.toolName)));
    if (normalizedNames.size > 1) return `${items.length} tool calls failed`;
  }

  const counts: Array<{ key: string; toolName: string; count: number; status: GroupStatus }> = [];
  for (const item of items) {
    const key = normalizeToolName(item.toolName);
    const existing = counts.find((entry) => entry.key === key);
    const status: GroupStatus = item.isError ? "failed" : item.status === "streaming" ? "streaming" : "done";
    if (existing) {
      existing.count += 1;
      if (status === "failed") existing.status = "failed";
      if (status === "streaming" && existing.status !== "failed") existing.status = "streaming";
    } else {
      counts.push({ key, toolName: item.toolName, count: 1, status });
    }
  }

  return joinPhrases(counts.map((entry) => toolGroupPhrase(entry.toolName, entry.count, entry.status)));
}

function chooseGroupIcon(items: ToolItem[]): ReturnType<typeof getToolInfo>["icon"] {
  const normalized = items.map((item) => normalizeToolName(item.toolName));
  if (normalized.some((name) => name === "web_action" || name === "web_search" || name === "web_fetch")) {
    return "globe";
  }
  if (normalized.includes("bash")) return "terminal";
  if (normalized.some((name) => name === "grep" || name === "glob" || name === "overdaresearch")) {
    return "search";
  }
  if (normalized.includes("skill")) return "book";
  return getToolInfo(items[0]?.toolName ?? "tool").icon;
}

export function ToolActivityGroup({ items, initialOpen = false }: { items: ToolItem[]; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const title = useMemo(() => summarizeToolGroup(items), [items]);
  const firstInfo = getToolInfo(items[0]?.toolName ?? "tool");
  const icon = chooseGroupIcon(items);
  const isBusy = items.some((item) => item.status === "streaming");
  const isError = items.some((item) => item.isError);
  const durationLabel =
    !isBusy && !isError ? formatDurationLabel(Math.max(0, ...items.map((item) => item.durationMs ?? 0))) : null;

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-tool-row">
        <ToolActivityRow
          title={title}
          icon={icon}
          category={firstInfo.category}
          isError={isError}
          isBusy={isBusy}
          durationLabel={durationLabel}
          expanded={open}
          expandable={items.length > 0}
          onToggle={() => setOpen((value) => !value)}
        />

        {open ? (
          <div className="mt-0">
            {items.map((item) => (
              <ToolBlock key={item.id} item={item} nested inlinePreviewWhenCollapsed />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
