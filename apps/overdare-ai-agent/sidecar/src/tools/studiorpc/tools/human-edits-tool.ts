// @summary Reports what the human creator changed in Studio since the agent's last completed turn.

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Tool, ToolResult } from "../types";
import {
  decodeOvdrjm,
  isRecord,
  normalizeLeadingSpaces,
  normalizeLineEndings,
  type OvdrjmNode,
  readOvdrjmRoot,
} from "./ovdrjm-utils";
import { baselinePath } from "./snapshot";

const params = z.object({});

const description =
  "Compare the current level against the snapshot taken when the agent last finished, and summarize what " +
  "the human creator changed in Studio since then (added/removed/moved instances, property changes, script " +
  "edits). Call this BEFORE making any edits of your own in this turn — your own edits would otherwise show " +
  "up as human edits. Read-only.";

/** Properties never diffed: tree structure, derived caches, identity, and Source (diffed separately). */
const SKIPPED_PROPS = new Set(["LuaChildren", "WorldTransform", "ActorGuid", "Source"]);
const VALUE_MAX_CHARS = 120;
const SOURCE_DIFF_CAP = 20;

interface IndexEntry {
  node: OvdrjmNode;
  parentGuid?: string;
  parentName?: string;
}

/** Index every node carrying a string ActorGuid; nodes without one are skipped but still recursed into. */
function indexByGuid(root: OvdrjmNode): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  const walk = (node: OvdrjmNode, parent?: OvdrjmNode): void => {
    if (typeof node.ActorGuid === "string") {
      map.set(node.ActorGuid, {
        node,
        parentGuid: typeof parent?.ActorGuid === "string" ? parent.ActorGuid : undefined,
        parentName: typeof parent?.Name === "string" ? parent.Name : undefined,
      });
    }
    if (!Array.isArray(node.LuaChildren)) return;
    for (const child of node.LuaChildren) {
      if (isRecord(child)) walk(child as OvdrjmNode, node);
    }
  };
  walk(root);
  return map;
}

function label(entry: IndexEntry, guid: string): string {
  const type = typeof entry.node.InstanceType === "string" ? entry.node.InstanceType : "Instance";
  const name = typeof entry.node.Name === "string" ? entry.node.Name : guid;
  return `${type} "${name}" (${guid})`;
}

function parentLabel(entry: IndexEntry): string {
  if (!entry.parentGuid) return "the root";
  return `"${entry.parentName ?? entry.parentGuid}" (${entry.parentGuid})`;
}

function formatValue(value: unknown): string {
  const text = JSON.stringify(value) ?? "(none)";
  return text.length > VALUE_MAX_CHARS ? `${text.slice(0, VALUE_MAX_CHARS)}…` : text;
}

function diffProperties(before: OvdrjmNode, after: OvdrjmNode): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const lines: string[] = [];
  for (const key of keys) {
    if (SKIPPED_PROPS.has(key)) continue;
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    lines.push(`  ${key}: ${formatValue(a)} -> ${formatValue(b)}`);
  }
  return lines;
}

/** Same normalization the script edit tools apply before storing Source, to avoid formatting false positives. */
function normalizeSource(source: string): string {
  return normalizeLeadingSpaces(normalizeLineEndings(source).result).result;
}

function cappedLines(lines: string[], sign: "-" | "+"): string[] {
  const shown = lines.slice(0, SOURCE_DIFF_CAP).map((line) => `  ${sign} ${line}`);
  if (lines.length > SOURCE_DIFF_CAP) {
    shown.push(`  (… ${lines.length - SOURCE_DIFF_CAP} more lines)`);
  }
  return shown;
}

/**
 * Compact Source diff: trim common prefix/suffix lines, then emit the changed
 * block as `-`/`+` lines capped per side.
 * ponytail: prefix/suffix trim, not LCS — good enough for intent inference.
 */
function diffSource(before: OvdrjmNode, after: OvdrjmNode): string | undefined {
  const a = typeof before.Source === "string" ? normalizeSource(before.Source) : undefined;
  const b = typeof after.Source === "string" ? normalizeSource(after.Source) : undefined;
  if (a === b) return undefined;
  const oldLines = (a ?? "").split("\n");
  const newLines = (b ?? "").split("\n");

  const max = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < max && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) {
    suffix++;
  }

  const removedLines = oldLines.slice(prefix, oldLines.length - suffix);
  const addedLines = newLines.slice(prefix, newLines.length - suffix);
  const lastChanged = Math.max(prefix + 1, newLines.length - suffix);
  return [
    `lines ${prefix + 1}-${lastChanged}:`,
    ...cappedLines(removedLines, "-"),
    ...cappedLines(addedLines, "+"),
  ].join("\n");
}

/** Diff two .ovdrjm root nodes into a compact human-edit summary. Exported for tests. */
export function diffOvdrjmRoots(baseline: OvdrjmNode, current: OvdrjmNode): string {
  const before = indexByGuid(baseline);
  const after = indexByGuid(current);

  const added: string[] = [];
  const removed: string[] = [];
  const moved: string[] = [];
  const modified: string[] = [];
  const sourceChanged: string[] = [];

  for (const [guid, entry] of after) {
    if (!before.has(guid)) added.push(`+ ${label(entry, guid)} under ${parentLabel(entry)}`);
  }
  for (const [guid, entry] of before) {
    if (!after.has(guid)) removed.push(`- ${label(entry, guid)} was under ${parentLabel(entry)}`);
  }
  for (const [guid, entryAfter] of after) {
    const entryBefore = before.get(guid);
    if (!entryBefore) continue;
    if (entryBefore.parentGuid !== entryAfter.parentGuid) {
      moved.push(`> ${label(entryAfter, guid)}: from ${parentLabel(entryBefore)} to ${parentLabel(entryAfter)}`);
    }
    const propLines = diffProperties(entryBefore.node, entryAfter.node);
    if (propLines.length > 0) {
      modified.push([`~ ${label(entryAfter, guid)}`, ...propLines].join("\n"));
    }
    const sourceDiff = diffSource(entryBefore.node, entryAfter.node);
    if (sourceDiff) sourceChanged.push(`* ${label(entryAfter, guid)} ${sourceDiff}`);
  }

  const sections: string[] = [];
  if (added.length > 0) sections.push(`Added (${added.length}):\n${added.join("\n")}`);
  if (removed.length > 0) sections.push(`Removed (${removed.length}):\n${removed.join("\n")}`);
  if (moved.length > 0) sections.push(`Moved (${moved.length}):\n${moved.join("\n")}`);
  if (modified.length > 0) sections.push(`Modified (${modified.length}):\n${modified.join("\n")}`);
  if (sourceChanged.length > 0) {
    sections.push(`Script source changed (${sourceChanged.length}):\n${sourceChanged.join("\n")}`);
  }

  if (sections.length === 0) {
    return NO_EDITS_MESSAGE;
  }
  return `Human edits since the agent's last completed turn:\n\n${sections.join("\n\n")}`;
}

const NO_EDITS_MESSAGE = "No human edits detected since the agent's last completed turn.";

/**
 * Diff the agent-done baseline against the .ovdrjm as it is right now. The
 * provider calls this at turn start (before any agent edits) and caches the
 * result, so late tool calls cannot misattribute agent edits to the human.
 */
export function computeHumanEdits(cwd: string): ToolResult {
  const baseline = baselinePath(cwd);
  if (!existsSync(baseline)) {
    return {
      output:
        "No baseline snapshot exists yet. The baseline is captured when the agent finishes a turn, so there " +
        "is nothing to compare against. Proceed without human-edit context.",
      metadata: { method: "human_edits", noBaseline: true },
    };
  }

  try {
    const baselineDoc = JSON.parse(decodeOvdrjm(readFileSync(baseline))) as Record<string, unknown>;
    const baselineRoot = baselineDoc.Root;
    if (!isRecord(baselineRoot)) {
      throw new Error("Invalid baseline snapshot: Root object is missing.");
    }
    const { root: currentRoot } = readOvdrjmRoot(cwd);
    const output = diffOvdrjmRoots(baselineRoot as OvdrjmNode, currentRoot);
    return {
      output,
      metadata: { method: "human_edits", humanEditsDetected: output !== NO_EDITS_MESSAGE },
    };
  } catch (error) {
    return {
      output: `Error: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { error: true, method: "human_edits" },
    };
  }
}

export function createHumanEditsTool(cwd: string, getCached?: () => ToolResult | undefined): Tool {
  return {
    name: "studiorpc_human_edits",
    description,
    parameters: params,
    async execute() {
      // Prefer the turn-start cache; fall back to a live diff when no hook ran.
      return getCached?.() ?? computeHumanEdits(cwd);
    },
  };
}
