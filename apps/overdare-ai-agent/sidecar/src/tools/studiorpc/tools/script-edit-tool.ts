// @summary Edits a script's Source property in .ovdrjm via exact string replacement.

import { resolveApiVersion } from "../config";
import * as scriptEdit from "../methods/script.edit";
import { buildScriptEditRender } from "../render";
import { applyLevelChanges } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import {
  findNodeByActorGuid,
  isRecord,
  normalizeLeadingSpaces,
  normalizeLineEndings,
  type OvdrjmNode,
  readAndWriteOvdrjm,
  readOvdrjmRoot,
} from "./ovdrjm-utils";
import { editScriptViaRpc } from "./v2/script-edit";

// ---------------------------------------------------------------------------
// Helpers — line-oriented matching in the style of apply_patch's deriveNewContent.
// ---------------------------------------------------------------------------

interface SingleEdit {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

type MatchMode = "trimEnd" | "trim" | "unicode";

/**
 * Structured result returned by applyEdit() instead of throwing.
 *
 * - edited:          the replacement was applied; result holds the new content.
 * - already_applied: old_string not found but new_string is already in the
 *                    file — the edit was likely applied in a previous call.
 * - not_found:       old_string not found and new_string is not in the file
 *                    either — the caller should re-read the source before
 *                    retrying.
 * - ambiguous:       old_string matches multiple locations without replace_all;
 *                    the caller should add more context or pass replace_all.
 * - noop:            old_string and new_string are identical; nothing to do.
 */
type EditStatus =
  | { kind: "edited"; result: string; count: number }
  | { kind: "already_applied"; newMatchCount: number }
  | { kind: "not_found" }
  | { kind: "ambiguous"; matchCount: number; replaceAllAvailable: boolean }
  | { kind: "noop" };

function normalizeUnicode(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}

function compareLines(mode: MatchMode, actual: string, expected: string): boolean {
  switch (mode) {
    case "trimEnd":
      return actual.trimEnd() === expected.trimEnd();
    case "trim":
      return actual.trim() === expected.trim();
    case "unicode":
      return normalizeUnicode(actual.trim()) === normalizeUnicode(expected.trim());
  }
}

/**
 * Split into lines WITHOUT embedded terminators, remembering whether the
 * original ended with a newline so reassembly can reproduce it.
 */
function splitIntoLines(content: string): { lines: string[]; hasTrailingNewline: boolean } {
  if (content === "") return { lines: [], hasTrailingNewline: false };
  const parts = content.split(/\r\n|\r|\n/);
  const hasTrailingNewline = parts[parts.length - 1] === "";
  if (hasTrailingNewline) parts.pop();
  return { lines: parts, hasTrailingNewline };
}

function findExactMatches(content: string, search: string): Array<{ start: number; end: number }> {
  if (search.length === 0) return [];
  const matches: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while ((pos = content.indexOf(search, pos)) !== -1) {
    matches.push({ start: pos, end: pos + search.length });
    pos += search.length;
  }
  return matches;
}

function findLineMatches(contentLines: string[], searchLines: string[]): Array<{ startLine: number; endLine: number }> {
  if (searchLines.length === 0 || searchLines.length > contentLines.length) return [];

  const modes: MatchMode[] = ["trimEnd", "trim", "unicode"];
  for (const mode of modes) {
    const matches: Array<{ startLine: number; endLine: number }> = [];
    for (let index = 0; index <= contentLines.length - searchLines.length; index++) {
      let matched = true;
      for (let lineIndex = 0; lineIndex < searchLines.length; lineIndex++) {
        if (!compareLines(mode, contentLines[index + lineIndex], searchLines[lineIndex])) {
          matched = false;
          break;
        }
      }
      if (matched) matches.push({ startLine: index, endLine: index + searchLines.length });
    }
    if (matches.length > 0) return matches;
  }
  return [];
}

/**
 * Validate and apply a single edit to `content`, returning a structured
 * EditStatus instead of throwing.
 *
 * Two matching strategies:
 *   1. Character-level exact substring (handles within-line edits).
 *   2. Line-level fuzzy match (whitespace / Unicode tolerant). Operates on
 *      pure-line arrays so replacements can never accidentally eat a line
 *      terminator.
 */
function applyEdit(content: string, edit: SingleEdit): EditStatus {
  const { old_string, new_string, replace_all } = edit;

  if (old_string === new_string) {
    return { kind: "noop" };
  }

  const exact = findExactMatches(content, old_string);
  if (exact.length > 0) {
    if (!replace_all && exact.length > 1) {
      return { kind: "ambiguous", matchCount: exact.length, replaceAllAvailable: true };
    }
    const targets = replace_all ? exact : [exact[0]];
    let out = "";
    let last = 0;
    for (const match of targets) {
      out += content.slice(last, match.start);
      out += new_string;
      last = match.end;
    }
    out += content.slice(last);
    return { kind: "edited", result: out, count: targets.length };
  }

  const { lines: contentLines, hasTrailingNewline } = splitIntoLines(content);
  const { lines: searchLines } = splitIntoLines(old_string);
  const { lines: replacementLines } = splitIntoLines(new_string);

  const lineMatches = findLineMatches(contentLines, searchLines);
  if (lineMatches.length === 0) {
    const newExact = findExactMatches(content, new_string);
    if (newExact.length > 0) {
      return { kind: "already_applied", newMatchCount: newExact.length };
    }
    const newLineMatches = findLineMatches(contentLines, splitIntoLines(new_string).lines);
    if (newLineMatches.length > 0) {
      return { kind: "already_applied", newMatchCount: newLineMatches.length };
    }
    return { kind: "not_found" };
  }
  if (!replace_all && lineMatches.length > 1) {
    return { kind: "ambiguous", matchCount: lineMatches.length, replaceAllAvailable: true };
  }

  const targets = replace_all ? lineMatches : [lineMatches[0]];
  const next = [...contentLines];
  for (let i = targets.length - 1; i >= 0; i--) {
    const target = targets[i];
    next.splice(target.startLine, target.endLine - target.startLine, ...replacementLines);
  }

  const joined = next.join("\n");
  const result = hasTrailingNewline ? `${joined}\n` : joined;
  return { kind: "edited", result, count: targets.length };
}

// ---------------------------------------------------------------------------
// Script class guard
// ---------------------------------------------------------------------------

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

// ---------------------------------------------------------------------------
// script_edit tool
// ---------------------------------------------------------------------------

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

async function executeScriptEdit(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = toToolName(scriptEdit.method);
  const parsed = scriptEdit.params.parse(args);
  const { guid: targetGuid, old_string, new_string, replace_all } = parsed;

  if (old_string === "") {
    return { output: "Error: old_string cannot be empty for script edit", metadata: { error: true } };
  }

  // --- Approval ---
  const approval = await ctx.approve({
    permission: "write",
    toolName,
    description: `Edit script ${targetGuid}`,
    details: { targetGuid, old_string, new_string, replace_all },
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true } };
  }

  // --- Read source and classify the edit before writing ---
  let preCheckStatus: EditStatus;
  let scriptName: string | undefined;
  try {
    const { root } = readOvdrjmRoot(cwd);
    const target = findNodeByActorGuid(root, targetGuid);
    if (!target) {
      return { output: `Error: ActorGuid not found in .ovdrjm: ${targetGuid}`, metadata: { error: true } };
    }
    const instanceType = typeof target.InstanceType === "string" ? target.InstanceType : undefined;
    if (!instanceType || !SCRIPT_CLASSES.has(instanceType)) {
      return {
        output:
          `Error: Instance ${targetGuid} is ${instanceType ?? "unknown"}, not a script. ` +
          "Use studiorpc_instance_upsert to edit non-script instances.",
        metadata: { error: true },
      };
    }
    scriptName = typeof target.Name === "string" ? target.Name : undefined;
    const source = typeof target.Source === "string" ? target.Source : "";
    preCheckStatus = applyEdit(source, { old_string, new_string, replace_all });
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: true },
    };
  }

  if (preCheckStatus.kind !== "edited") {
    switch (preCheckStatus.kind) {
      case "already_applied":
        return {
          output: `Already applied: new_string found ${preCheckStatus.newMatchCount} time(s) in script ${targetGuid}; old_string not found. No changes made.`,
          metadata: {
            method: "script.edit",
            targetGuid,
            scriptName,
            editStatus: "already_applied",
            newMatchCount: preCheckStatus.newMatchCount,
          },
        };
      case "ambiguous":
        return {
          output: `Error: old_string matches ${preCheckStatus.matchCount} locations in script ${targetGuid}. Provide more context or use replace_all.`,
          metadata: {
            error: true,
            method: "script.edit",
            targetGuid,
            scriptName,
            editStatus: "ambiguous",
            matchCount: preCheckStatus.matchCount,
            replaceAllAvailable: preCheckStatus.replaceAllAvailable,
          },
        };
      case "not_found":
        return {
          output: `Error: old_string not found in script ${targetGuid}. Re-read the source before retrying.`,
          metadata: { error: true, method: "script.edit", targetGuid, scriptName, editStatus: "not_found" },
        };
      case "noop":
        return {
          output: `No-op: old_string and new_string are identical in script ${targetGuid}. No changes made.`,
          metadata: { method: "script.edit", targetGuid, scriptName, editStatus: "noop" },
        };
    }
  }

  // --- Apply the edit and write back ---
  const release = await writeLock.acquire();
  try {
    if (resolveApiVersion() === "v2") return await editScriptViaRpc(parsed);
    let count = 0;
    let tabCount = 0;
    let eolCount = 0;

    readAndWriteOvdrjm(cwd, (rootDoc) => {
      const root = rootDoc.Root;
      if (!isRecord(root)) {
        throw new Error("Invalid .ovdrjm format: Root object is missing.");
      }

      const target = findNodeByActorGuid(root as OvdrjmNode, targetGuid);
      if (!target) {
        throw new Error(`ActorGuid not found in .ovdrjm: ${targetGuid}`);
      }

      const source = typeof target.Source === "string" ? target.Source : "";
      const writeStatus = applyEdit(source, { old_string, new_string, replace_all });

      if (writeStatus.kind !== "edited") {
        throw new Error(
          `Edit status changed between read and write: ${writeStatus.kind}. Source may have changed concurrently.`,
        );
      }

      // Normalize leading 4-spaces → tabs, then line endings for the current OS
      const normalized = normalizeLeadingSpaces(writeStatus.result);
      const eolNormalized = normalizeLineEndings(normalized.result);
      target.Source = eolNormalized.result;
      tabCount = normalized.converted;
      eolCount = eolNormalized.converted;
      count = writeStatus.count;
    });

    await applyLevelChanges();

    let output = `Edited script ${targetGuid}: replaced ${count} occurrence(s)`;
    const normalizations: string[] = [];
    if (tabCount > 0) normalizations.push(`${tabCount} leading 4-space group(s) → tabs`);
    if (eolCount > 0) normalizations.push(`${eolCount} line ending(s) normalized`);
    if (normalizations.length > 0) output += ` (${normalizations.join(", ")})`;
    return {
      output,
      render: buildScriptEditRender({ targetGuid, scriptName, old_string, new_string, replace_all }, output, count),
      metadata: { method: "script.edit", targetGuid, scriptName, editStatus: "edited", count },
    };
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: true },
    };
  } finally {
    release();
  }
}

export function createScriptEditTool(cwd: string, writeLock: WriteLock): Tool {
  return {
    name: toToolName(scriptEdit.method),
    description: scriptEdit.description,
    parameters: scriptEdit.params,
    async execute(args, ctx) {
      return executeScriptEdit(args, ctx, cwd, writeLock);
    },
  };
}

export { applyEdit };
