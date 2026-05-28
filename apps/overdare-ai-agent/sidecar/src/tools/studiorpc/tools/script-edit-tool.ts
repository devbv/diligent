// @summary Edits a script's Source property in .ovdrjm via exact string replacement.

import * as scriptEdit from "../methods/script.edit";
import { buildScriptEditRender } from "../render";
import { applyAndSave } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import {
  findNodeByActorGuid,
  isRecord,
  normalizeLeadingSpaces,
  normalizeLineEndings,
  type OvdrjmNode,
  readAndWriteOvdrjm,
} from "./ovdrjm-utils";

// ---------------------------------------------------------------------------
// Helpers — line-oriented matching in the style of apply_patch's deriveNewContent.
// ---------------------------------------------------------------------------

interface SingleEdit {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

type MatchMode = "trimEnd" | "trim" | "unicode";

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
 * Validate and apply a single edit to `content`, returning the new content and
 * the number of replacements made. Throws on validation failure.
 *
 * Two matching strategies:
 *   1. Character-level exact substring (handles within-line edits).
 *   2. Line-level fuzzy match (whitespace / Unicode tolerant). Operates on
 *      pure-line arrays so replacements can never accidentally eat a line
 *      terminator.
 */
function applyEdit(content: string, edit: SingleEdit): { result: string; count: number } {
  const { old_string, new_string, replace_all } = edit;

  if (old_string === new_string) {
    throw new Error("old_string and new_string must differ");
  }

  const exact = findExactMatches(content, old_string);
  if (exact.length > 0) {
    if (!replace_all && exact.length > 1) {
      throw new Error("old_string is not unique, provide more context or use replace_all");
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
    return { result: out, count: targets.length };
  }

  const { lines: contentLines, hasTrailingNewline } = splitIntoLines(content);
  const { lines: searchLines } = splitIntoLines(old_string);
  const { lines: replacementLines } = splitIntoLines(new_string);

  const lineMatches = findLineMatches(contentLines, searchLines);
  if (lineMatches.length === 0) {
    throw new Error("old_string not found in file");
  }
  if (!replace_all && lineMatches.length > 1) {
    throw new Error("old_string is not unique, provide more context or use replace_all");
  }

  const targets = replace_all ? lineMatches : [lineMatches[0]];
  const next = [...contentLines];
  for (let i = targets.length - 1; i >= 0; i--) {
    const target = targets[i];
    next.splice(target.startLine, target.endLine - target.startLine, ...replacementLines);
  }

  const joined = next.join("\n");
  const result = hasTrailingNewline ? `${joined}\n` : joined;
  return { result, count: targets.length };
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
  const { targetGuid, old_string, new_string, replace_all } = parsed;

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

  // --- Read .ovdrjm, apply edit, write back ---
  const release = await writeLock.acquire();
  try {
    let count = 0;
    let tabCount = 0;
    let eolCount = 0;
    let scriptName: string | undefined;

    readAndWriteOvdrjm(cwd, (rootDoc) => {
      const root = rootDoc.Root;
      if (!isRecord(root)) {
        throw new Error("Invalid .ovdrjm format: Root object is missing.");
      }

      const target = findNodeByActorGuid(root as OvdrjmNode, targetGuid);
      if (!target) {
        throw new Error(`ActorGuid not found in .ovdrjm: ${targetGuid}`);
      }

      const instanceType = typeof target.InstanceType === "string" ? target.InstanceType : undefined;
      if (!instanceType || !SCRIPT_CLASSES.has(instanceType)) {
        throw new Error(
          `Instance ${targetGuid} is ${instanceType ?? "unknown"}, not a script. ` +
            "Use studiorpc_instance_upsert to edit non-script instances.",
        );
      }

      scriptName = typeof target.Name === "string" ? target.Name : undefined;
      const source = typeof target.Source === "string" ? target.Source : "";

      const { result, count: editCount } = applyEdit(source, { old_string, new_string, replace_all });

      // Normalize leading 4-spaces → tabs, then line endings for the current OS
      const normalized = normalizeLeadingSpaces(result);
      const eolNormalized = normalizeLineEndings(normalized.result);
      target.Source = eolNormalized.result;
      tabCount = normalized.converted;
      eolCount = eolNormalized.converted;
      count = editCount;
    });

    await applyAndSave();

    let output = `Edited script ${targetGuid}: replaced ${count} occurrence(s)`;
    const normalizations: string[] = [];
    if (tabCount > 0) normalizations.push(`${tabCount} leading 4-space group(s) → tabs`);
    if (eolCount > 0) normalizations.push(`${eolCount} line ending(s) normalized`);
    if (normalizations.length > 0) output += ` (${normalizations.join(", ")})`;
    return {
      output,
      render: buildScriptEditRender({ targetGuid, scriptName, old_string, new_string, replace_all }, output, count),
      metadata: { method: "script.edit", targetGuid, count },
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
