// @summary Runtime helpers for generic text payloads and tool-specific producer render block builders

import type { DiffFile, ToolRenderPayload } from "@diligent/protocol";

export interface SearchRenderPayloadOptions {
  cwd?: string;
}

export interface SearchRenderInput {
  pattern?: string;
  path?: string;
}

export interface UpdateKnowledgeRenderInput {
  action?: string;
  id?: string;
  type?: string;
  content?: string;
  tags?: string[];
}

export interface SearchKnowledgeRenderInput {
  id?: string;
  query?: string;
}

export interface PlanRenderStepInput {
  text: string;
  status?: "pending" | "in_progress" | "done" | "cancelled";
}

export function summarizeRenderText(text: string | undefined, maxLength = 80): string | undefined {
  if (!text) return undefined;
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const relativized = relativizeCwdPrefixInSummary(firstLine);
  return clipInlineText(relativized, maxLength);
}

export function createTextRenderPayload(
  inputText?: string,
  outputText?: string,
  isError = false,
): ToolRenderPayload | undefined {
  const inputSummary = summarizeRenderText(inputText);
  const outputSummary = summarizeRenderText(outputText);
  const blocks: ToolRenderPayload["blocks"] = [];
  if (inputText?.trim()) blocks.push({ type: "text", title: "Input", text: inputText });
  if (outputText?.trim()) blocks.push({ type: "text", title: "Output", text: outputText, isError });
  if (!inputSummary && !outputSummary && blocks.length === 0) return undefined;
  return { inputSummary, outputSummary, blocks };
}

export function createCommandRenderPayload(command: string, outputText: string, isError: boolean): ToolRenderPayload {
  return {
    inputSummary: summarizeRenderText(command, 120),
    outputSummary: summarizeCommandOutput(outputText, isError),
    blocks: [{ type: "command", command, output: outputText || undefined, isError }],
  };
}

export function createFileRenderPayload(args: {
  filePath: string;
  content?: string;
  offset?: number;
  limit?: number;
  isError?: boolean;
  outputText?: string;
  actionSummary?: string;
}): ToolRenderPayload {
  return {
    inputSummary: summarizeRenderText(args.filePath),
    outputSummary: args.actionSummary ?? summarizeRenderText(args.outputText),
    blocks: [
      {
        type: "file",
        filePath: args.filePath,
        content: args.content,
        offset: args.offset,
        limit: args.limit,
        isError: args.isError,
      },
    ],
  };
}

export function createEditDiffRenderPayload(args: {
  filePath: string;
  oldString?: string;
  newString?: string;
  outputText: string;
  actionSummary?: string;
}): ToolRenderPayload {
  const action = args.oldString === "" ? ("Add" as const) : undefined;
  return {
    inputSummary: summarizeRenderText(args.filePath),
    outputSummary: args.actionSummary ?? summarizeRenderText(args.outputText),
    blocks: [
      {
        type: "diff",
        files: [
          {
            filePath: args.filePath,
            action,
            hunks: [{ oldString: args.oldString || undefined, newString: args.newString }],
          },
        ],
        output: args.outputText.split("\n")[0] || undefined,
      },
    ],
  };
}

export function createMultiEditDiffRenderPayload(args: {
  filePath: string;
  edits: Array<{ old_string: string; new_string: string }>;
  outputText: string;
  actionSummary?: string;
}): ToolRenderPayload {
  return {
    inputSummary: summarizeRenderText(args.filePath),
    outputSummary: args.actionSummary ?? summarizeRenderText(args.outputText),
    blocks: [
      {
        type: "diff",
        files: [
          {
            filePath: args.filePath,
            hunks: args.edits.map((edit) => ({ oldString: edit.old_string || undefined, newString: edit.new_string })),
          },
        ],
        output: args.outputText.split("\n")[0] || undefined,
      },
    ],
  };
}

export function createPatchDiffRenderPayload(
  patch: string,
  outputText: string,
  actionSummary?: string,
): ToolRenderPayload | undefined {
  const files = parsePatchForRender(patch);
  if (files.length === 0) return undefined;
  return {
    inputSummary: buildPatchInputSummary(files),
    outputSummary: actionSummary ?? summarizeRenderText(outputText),
    blocks: [{ type: "diff", files, output: outputText.split("\n")[0] || undefined }],
  };
}

export function createPlanRenderPayload(args: {
  title?: string;
  steps: PlanRenderStepInput[];
  hint?: string;
}): ToolRenderPayload {
  const title = readTrimmedString(args.title) ?? "Plan";
  const steps = args.steps.map((step) => ({
    text: readTrimmedString(step.text) ?? "(empty)",
    status: step.status ?? "pending",
  }));
  const pending = steps.filter((step) => step.status === "pending").length;
  const inProgress = steps.filter((step) => step.status === "in_progress").length;
  const done = steps.filter((step) => step.status === "done").length;
  const cancelled = steps.filter((step) => step.status === "cancelled").length;
  const allResolved = pending + inProgress === 0;
  const items = steps.map((step) => `${statusIcon(step.status)} ${step.text}`);
  const blocks: ToolRenderPayload["blocks"] = [
    {
      type: "key_value",
      title: "Progress",
      items: [
        { key: "done", value: String(done) },
        { key: "in_progress", value: String(inProgress) },
        { key: "pending", value: String(pending) },
        { key: "cancelled", value: String(cancelled) },
      ],
    },
    {
      type: "list",
      title,
      ordered: true,
      items,
    },
  ];

  const hintText = readTrimmedString(args.hint);
  if (hintText) {
    blocks.push({
      type: "summary",
      text: hintText,
      tone: allResolved ? "success" : "info",
    });
  }

  return {
    inputSummary: summarizeRenderText(`${title} (${steps.length} steps)`, 120),
    outputSummary: allResolved ? "All steps resolved" : `${done}/${steps.length} done`,
    blocks,
  };
}

export function createGlobRenderPayload(
  input: SearchRenderInput,
  outputText: string,
  options?: SearchRenderPayloadOptions,
): ToolRenderPayload {
  const basePath = readAbsolutePath(input.path);
  const pattern = readTrimmedString(input.pattern);
  const searchPath = readTrimmedString(input.path);
  const displaySearchPath = relativizePathAgainstCwd(searchPath, options?.cwd);
  const rawItems = toOutputLines(outputText);
  const items = relativizeGlobOutputLines(rawItems, basePath);
  const queryItems = buildQueryItems({ pattern, path: displaySearchPath });
  debugRenderPayload("glob_paths", {
    basePath: basePath ?? null,
    itemCount: items.length,
    changedCount: countChangedItems(rawItems, items),
    sampleBefore: rawItems.slice(0, 3),
    sampleAfter: items.slice(0, 3),
  });

  const blocks: ToolRenderPayload["blocks"] = [
    { type: "summary", text: buildSearchHeader(pattern, displaySearchPath), tone: "info" },
    { type: "list", title: buildFoundTitle(items.length, "file"), items },
  ];
  if (queryItems.length > 0) blocks.push({ type: "key_value", title: "Query", items: queryItems });
  return {
    inputSummary: summarizeRenderText(buildSearchSummary(pattern, displaySearchPath)),
    outputSummary: buildResultSummary(items.length, "file", outputText, "found"),
    blocks,
  };
}

export function createGrepRenderPayload(
  input: SearchRenderInput,
  outputText: string,
  options?: SearchRenderPayloadOptions,
): ToolRenderPayload {
  const basePath = readAbsolutePath(input.path);
  const pattern = readTrimmedString(input.pattern);
  const searchPath = readTrimmedString(input.path);
  const displaySearchPath = relativizePathAgainstCwd(searchPath, options?.cwd);
  const rawItems = toOutputLines(outputText);
  const relativizedItems = relativizeGrepOutputLines(rawItems, basePath);
  const items = relativizedItems.filter((line) => !line.startsWith("..."));
  const queryItems = buildQueryItems({ pattern, path: displaySearchPath });
  debugRenderPayload("grep_paths", {
    basePath: basePath ?? null,
    rawCount: rawItems.length,
    itemCount: items.length,
    changedCount: countChangedItems(rawItems, relativizedItems),
    sampleBefore: rawItems.slice(0, 3),
    sampleAfter: relativizedItems.slice(0, 3),
  });

  const blocks: ToolRenderPayload["blocks"] = [
    { type: "summary", text: buildSearchHeader(pattern, displaySearchPath), tone: "info" },
    { type: "list", title: buildFoundTitle(items.length, "match"), items },
  ];
  if (queryItems.length > 0) blocks.push({ type: "key_value", title: "Query", items: queryItems });
  return {
    inputSummary: summarizeRenderText(buildSearchSummary(pattern, displaySearchPath)),
    outputSummary: buildResultSummary(items.length, "match", outputText, "found"),
    blocks,
  };
}

export function createListRenderPayload(outputText: string): ToolRenderPayload | undefined {
  const items = toOutputLines(outputText).filter((line) => !line.startsWith("..."));
  if (items.length === 0) return undefined;
  return {
    outputSummary: buildResultSummary(items.length, "entry", outputText, "listed"),
    blocks: [{ type: "list", items }],
  };
}

export function createUpdateKnowledgeRenderPayload(
  input: UpdateKnowledgeRenderInput,
  outputText: string,
  isError: boolean,
): ToolRenderPayload | undefined {
  const actionValue = typeof input.action === "string" ? input.action : "upsert";
  const action = actionValue === "delete" ? "delete" : "upsert";
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const typeValue = typeof input.type === "string" ? input.type.trim() : "";
  const content = typeof input.content === "string" ? input.content : "";
  const tags = Array.isArray(input.tags)
    ? input.tags
        .map((value) => String(value).trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];

  const contentPreview = content ? clipInlineText(content.replace(/\s+/g, " ").trim(), 140) : "";
  const items = [
    { key: "action", value: action },
    ...(id ? [{ key: "id", value: id }] : []),
    ...(typeValue ? [{ key: "type", value: typeValue }] : []),
    ...(contentPreview ? [{ key: "content", value: contentPreview }] : []),
    ...(tags.length > 0 ? [{ key: "tags", value: tags.join(", ") }] : []),
  ];

  const outputSummary = outputText
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const blocks: ToolRenderPayload["blocks"] = [];
  if (items.length > 0) blocks.push({ type: "key_value", items });
  if (tags.length > 0) {
    blocks.push({ type: "status_badges", title: "Tags", items: tags.map((tag) => ({ label: tag })) });
  }
  if (outputSummary) blocks.push({ type: "summary", text: outputSummary, tone: isError ? "muted" : "success" });
  if (blocks.length === 0) return undefined;

  return {
    inputSummary: buildKnowledgeInputSummary(input, contentPreview),
    outputSummary: buildKnowledgeSummary(input, outputSummary),
    blocks,
  };
}

export function createSearchKnowledgeRenderPayload(
  input: SearchKnowledgeRenderInput,
  matches: Array<{
    id: string;
    type: string;
    content: string;
    timestamp: string;
    tags?: string[];
  }>,
  outputText: string,
  isError: boolean,
): ToolRenderPayload | undefined {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const queryPreview = query ? clipInlineText(query.replace(/\s+/g, " "), 140) : "";
  const queryItems = [
    ...(id ? [{ key: "id", value: id }] : []),
    ...(queryPreview ? [{ key: "query", value: queryPreview }] : []),
  ];
  const blocks: ToolRenderPayload["blocks"] = [];
  if (queryItems.length > 0) blocks.push({ type: "key_value", title: "Query", items: queryItems });
  if (matches.length > 0) {
    blocks.push({
      type: "list",
      title: `${matches.length} knowledge ${matches.length === 1 ? "entry" : "entries"}`,
      items: matches.map((match) => {
        const summary = `[${match.type}] ${clipInlineText(match.content.replace(/\s+/g, " ").trim(), 120)}`;
        return `${match.id} — ${summary}`;
      }),
    });
  }
  const firstLine = outputText
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine) blocks.push({ type: "summary", text: firstLine, tone: isError ? "muted" : "info" });
  if (blocks.length === 0) return undefined;

  return {
    inputSummary: buildSearchKnowledgeInputSummary(input),
    outputSummary: firstLine ?? (matches.length === 0 ? "No knowledge entries found" : undefined),
    blocks,
  };
}

export function buildPatchInputSummary(files: DiffFile[]): string | undefined {
  if (files.length === 0) return undefined;
  const first = buildPatchFileLabel(files[0]);
  if (files.length === 1) return summarizeRenderText(first, 120);
  return summarizeRenderText(`${first} (+${files.length - 1} more)`, 120);
}

function buildPatchFileLabel(file: DiffFile): string {
  if (file.action === "Move" && file.movedTo) {
    return `${file.filePath} -> ${file.movedTo}`;
  }
  return file.filePath;
}

export function buildKnowledgeInputSummary(
  input: UpdateKnowledgeRenderInput,
  contentPreview: string,
): string | undefined {
  const actionValue = typeof input.action === "string" ? input.action : "upsert";
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (actionValue === "delete") {
    if (id) return summarizeRenderText(`delete ${id}`, 120);
    return "delete";
  }

  const typeValue = typeof input.type === "string" ? input.type.trim() : "";
  if (typeValue && contentPreview) {
    return summarizeRenderText(`${typeValue}: ${contentPreview}`, 120);
  }
  if (typeValue) return summarizeRenderText(typeValue, 120);
  if (id) return summarizeRenderText(`upsert ${id}`, 120);
  return "upsert";
}

export function buildSearchKnowledgeInputSummary(input: SearchKnowledgeRenderInput): string | undefined {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const queryPreview = query ? clipInlineText(query.replace(/\s+/g, " "), 120) : "";
  if (id && queryPreview) return summarizeRenderText(`id:${id} query:${queryPreview}`, 120);
  if (id) return summarizeRenderText(`id:${id}`, 120);
  if (queryPreview) return summarizeRenderText(`query:${queryPreview}`, 120);
  return "search knowledge";
}

export function parsePatchForRender(patch: string): DiffFile[] {
  const lines = patch.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLines: string[] = [];
  let newLines: string[] = [];

  const flushHunk = () => {
    if (!current) return;
    if (oldLines.length > 0 || newLines.length > 0) {
      current.hunks.push({ oldString: oldLines.join("\n") || undefined, newString: newLines.join("\n") });
      oldLines = [];
      newLines = [];
    }
  };

  const flushFile = () => {
    flushHunk();
    if (current) files.push(current);
    current = null;
  };

  for (const line of lines) {
    const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
    if (addMatch) {
      flushFile();
      current = { filePath: addMatch[1].trim(), action: "Add", hunks: [] };
      continue;
    }

    const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
    if (deleteMatch) {
      flushFile();
      current = { filePath: deleteMatch[1].trim(), action: "Delete", hunks: [] };
      continue;
    }

    const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
    if (updateMatch) {
      flushFile();
      current = { filePath: updateMatch[1].trim(), action: "Update", hunks: [] };
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (moveMatch && current) {
      current.movedTo = moveMatch[1].trim();
      current.action = "Move";
      continue;
    }

    if (!current) continue;
    if (line.startsWith("@@")) {
      flushHunk();
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }

  flushFile();
  return files;
}

function statusIcon(status: PlanRenderStepInput["status"]): string {
  if (status === "done") return "☑";
  if (status === "in_progress") return "▶";
  if (status === "cancelled") return "⊘";
  return "☐";
}

export function clipInlineText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function relativizeCwdPrefixInSummary(value: string): string {
  const cwd = readProcessCwd();
  if (!cwd) return value;

  const normalizedCwd = trimTrailingSlash(normalizePath(cwd));
  if (!normalizedCwd) return value;

  const candidates = new Set<string>([normalizedCwd, cwd, cwd.replace(/\\/g, "/"), cwd.replace(/\//g, "\\")]);

  let nextValue = value;
  for (const candidate of candidates) {
    if (!candidate) continue;
    nextValue = replaceCwdPrefix(nextValue, candidate);
  }
  return nextValue;
}

function replaceCwdPrefix(value: string, cwdPrefix: string): string {
  let nextValue = value;
  nextValue = nextValue.replaceAll(`${cwdPrefix}/`, "");
  nextValue = nextValue.replaceAll(`${cwdPrefix}\\`, "");
  nextValue = nextValue.replaceAll(cwdPrefix, ".");
  return nextValue;
}

function countChangedItems(before: string[], after: string[]): number {
  const limit = Math.min(before.length, after.length);
  let changedCount = 0;
  for (let index = 0; index < limit; index += 1) {
    if (before[index] !== after[index]) changedCount += 1;
  }
  changedCount += Math.abs(before.length - after.length);
  return changedCount;
}

function isRenderPayloadDebugEnabled(): boolean {
  const value = readProcessEnv("DILIGENT_DEBUG_RENDER_PAYLOAD");
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function debugRenderPayload(event: string, data: Record<string, unknown>): void {
  if (!isRenderPayloadDebugEnabled()) return;
  console.debug("[render-payload]", event, data);
}

function buildSearchSummary(pattern?: string, path?: string): string {
  const parts: string[] = [];
  if (pattern) parts.push(`pattern: ${JSON.stringify(pattern)}`);
  if (path) parts.push(`path: ${JSON.stringify(path)}`);
  if (parts.length === 0) return "Search";
  return `Search(${parts.join(", ")})`;
}

function buildSearchHeader(pattern?: string, path?: string): string {
  return buildSearchSummary(pattern, path);
}

function buildFoundTitle(count: number, singularNoun: string): string {
  const noun = pluralizeNoun(singularNoun, count);
  return `└ Found ${count} ${noun}`;
}

function buildResultSummary(
  count: number,
  singularNoun: string,
  outputText: string,
  verb: "found" | "listed" | "read",
): string {
  if (count === 0) return summarizeRenderText(outputText) ?? `0 ${pluralizeNoun(singularNoun, 0)} ${verb}`;
  return `${count} ${pluralizeNoun(singularNoun, count)} ${verb}`;
}

function summarizeCommandOutput(outputText: string, isError: boolean): string | undefined {
  if (!outputText.trim()) return isError ? "Command failed" : "Command completed";
  if (outputText.includes("[Timed out")) return "Command timed out";
  if (outputText.includes("[Aborted by user]")) return "Command aborted";
  const exitCodeMatch = outputText.match(/\[Exit code: (\d+)\]/);
  if (exitCodeMatch) return `Command failed (exit ${exitCodeMatch[1]})`;
  return isError ? "Command failed" : "Command completed";
}

function buildKnowledgeSummary(
  input: UpdateKnowledgeRenderInput,
  fallbackSummary: string | undefined,
): string | undefined {
  const actionValue = typeof input.action === "string" ? input.action : "upsert";
  if (actionValue === "delete") {
    return fallbackSummary?.startsWith("Knowledge not found") ? "Knowledge not found" : "1 knowledge entry deleted";
  }
  if (typeof input.id === "string" && input.id.trim()) return "1 knowledge entry updated";
  return "1 knowledge entry saved";
}

function pluralizeNoun(singularNoun: string, count: number): string {
  if (count === 1) return singularNoun;
  if (singularNoun === "match") return "matches";
  if (singularNoun === "entry") return "entries";
  return `${singularNoun}s`;
}

function buildQueryItems(values: { pattern?: string; path?: string }): Array<{ key: string; value: string }> {
  const items: Array<{ key: string; value: string }> = [];
  if (values.pattern) items.push({ key: "pattern", value: values.pattern });
  if (values.path) items.push({ key: "path", value: values.path });
  return items;
}

function relativizePathAgainstCwd(pathValue: string | undefined, cwdOverride?: string): string | undefined {
  if (!pathValue) return undefined;
  const normalized = normalizePath(pathValue);
  if (!isAbsolutePath(normalized)) return pathValue;
  if (!cwdOverride) return normalized;
  return maybeRelativePath(normalized, cwdOverride);
}

function readProcessEnv(name: string): string | undefined {
  const proc = typeof process !== "undefined" ? process : undefined;
  const value = proc?.env?.[name];
  return typeof value === "string" ? value : undefined;
}

function readProcessCwd(): string | undefined {
  const proc = typeof process !== "undefined" ? process : undefined;
  if (!proc || typeof proc.cwd !== "function") return undefined;
  try {
    const value = proc.cwd();
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function readTrimmedString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toOutputLines(outputText: string): string[] {
  return outputText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function readAbsolutePath(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizePath(value);
  return isAbsolutePath(normalized) ? normalized : undefined;
}

function relativizeGlobOutputLines(lines: string[], basePath?: string): string[] {
  if (!basePath) return lines;
  return lines.map((line) => (line.startsWith("...") ? line : maybeRelativePath(line, basePath)));
}

function relativizeGrepOutputLines(lines: string[], basePath?: string): string[] {
  if (!basePath) return lines;
  return lines.map((line) => {
    if (line.startsWith("...")) return line;
    const parsedLine = splitGrepOutputLine(line);
    if (!parsedLine) return line;
    const relativePath = maybeRelativePathAgainstSearchScope(parsedLine.path, basePath);
    return `${relativePath}${parsedLine.suffix}`;
  });
}

function splitGrepOutputLine(line: string): { path: string; suffix: string } | undefined {
  const markerRegex = /([:-])\d+([:-])/g;
  for (const match of line.matchAll(markerRegex)) {
    const markerStart = match.index;
    if (markerStart === undefined || markerStart <= 0) continue;
    const candidatePath = line.slice(0, markerStart);
    if (!isAbsolutePath(candidatePath)) continue;
    return { path: candidatePath, suffix: line.slice(markerStart) };
  }
  return undefined;
}

function maybeRelativePathAgainstSearchScope(absPath: string, searchPath: string): string {
  const fromSearchPath = maybeRelativePath(absPath, searchPath);
  if (fromSearchPath !== absPath && fromSearchPath !== ".") return fromSearchPath;

  const parent = dirname(searchPath);
  if (!parent) return absPath;
  const fromParent = maybeRelativePath(absPath, parent);
  return fromParent === "." ? absPath : fromParent;
}

function maybeRelativePath(value: string, basePath: string): string {
  const path = normalizePath(value);
  const base = normalizePath(basePath);
  if (!isAbsolutePath(path) || !isAbsolutePath(base)) return value;

  const pathDrive = getDrive(path);
  const baseDrive = getDrive(base);
  if (pathDrive && baseDrive && pathDrive.toLowerCase() !== baseDrive.toLowerCase()) return value;

  const normalizedBase = trimTrailingSlash(base);
  if (path === normalizedBase) return ".";

  const comparePath = pathDrive ? path.toLowerCase() : path;
  const compareBase = pathDrive ? normalizedBase.toLowerCase() : normalizedBase;
  const prefix = `${compareBase}/`;
  if (!comparePath.startsWith(prefix)) return value;

  return path.slice(normalizedBase.length + 1);
}

function dirname(pathValue: string): string | undefined {
  const path = trimTrailingSlash(normalizePath(pathValue));
  const slash = path.lastIndexOf("/");
  if (slash < 0) return undefined;
  if (slash === 0) return "/";
  if (/^[a-zA-Z]:$/.test(path.slice(0, slash))) return `${path.slice(0, slash)}/`;
  return path.slice(0, slash);
}

function trimTrailingSlash(pathValue: string): string {
  if (pathValue === "/") return pathValue;
  if (/^[a-zA-Z]:\/$/.test(pathValue)) return pathValue;
  return pathValue.endsWith("/") ? pathValue.slice(0, -1) : pathValue;
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function getDrive(pathValue: string): string | undefined {
  const match = pathValue.match(/^([a-zA-Z]:)\//);
  return match?.[1];
}

function isAbsolutePath(pathValue: string): boolean {
  if (pathValue.startsWith("/")) return true;
  return /^[a-zA-Z]:\//.test(pathValue);
}
