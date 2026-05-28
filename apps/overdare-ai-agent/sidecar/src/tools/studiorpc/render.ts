// @summary Builds tool render payloads for Studio RPC methods.
import type { ToolRenderPayload } from "./types";

type TreeNode = { label: string; children?: TreeNode[] };

function isStructuralSummaryLine(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed === "{" || trimmed === "[" || trimmed === "}" || trimmed === "]") return true;
  if (/^<[^>]+>$/.test(trimmed)) return true;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  return false;
}

function isStructuredOutput(text: string | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  return trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("<");
}

function firstLine(text: string, fallback: string): string {
  if (isStructuredOutput(text)) return fallback;
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !isStructuralSummaryLine(value));
  return line || fallback;
}

function summarizeText(text: string | undefined, fallback?: string): string | undefined {
  if (isStructuredOutput(text)) return fallback;
  const line = text
    ?.split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !isStructuralSummaryLine(value));
  if (line) return line;
  return fallback;
}

function summarizeCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function clip(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function summarizeTargets(values: string[], actionWord: string): string {
  if (values.length === 0) return actionWord;
  if (values.length === 1) return `${actionWord} ${values[0]}`;
  if (values.length === 2) return `${actionWord} ${values[0]}, ${values[1]}`;
  return `${actionWord} ${values[0]}, ${values[1]} +${values.length - 2}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildScriptVirtualPath(targetGuid: string, scriptName?: string): string {
  const trimmedName = scriptName?.trim();
  return trimmedName ? `studio-scripts/${trimmedName} (${targetGuid}).lua` : `studio-scripts/${targetGuid}.lua`;
}

function toTreeNode(value: Record<string, unknown>): TreeNode | undefined {
  const name = readString(value.name) ?? "Instance";
  const className = readString(value.class);
  const filename = readString(value.filename);
  const childrenValue = Array.isArray(value.children) ? value.children : [];
  const children = childrenValue.flatMap((child) => {
    if (!isRecord(child)) return [];
    const node = toTreeNode(child);
    return node ? [node] : [];
  });
  const label = [name, className ? `(${className})` : "", filename ? `— ${filename}` : ""].filter(Boolean).join(" ");
  return { label, ...(children.length > 0 ? { children } : {}) };
}

export function buildLevelBrowseRender(result: unknown, args: Record<string, unknown>): ToolRenderPayload | undefined {
  const entries = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray((result as Record<string, unknown>).level)
      ? ((result as Record<string, unknown>).level as unknown[])
      : null;
  if (!entries) return undefined;
  const nodes = entries.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const node = toTreeNode(entry);
    return node ? [node] : [];
  });
  if (nodes.length === 0) return undefined;

  const startGuid = readString(args.startGuid);
  const classType = readString(args.classType);
  const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : undefined;

  const inputParts: string[] = ["browse"];
  if (startGuid) inputParts.push(`from:${startGuid}`);
  if (classType) inputParts.push(`class:${classType}`);
  if (maxDepth !== undefined) inputParts.push(`depth:${maxDepth}`);
  const inputSummary = clip(inputParts.join(" "));

  const kvItems: { key: string; value: string }[] = [];
  if (startGuid) kvItems.push({ key: "startGuid", value: startGuid });
  if (classType) kvItems.push({ key: "classType", value: classType });
  if (maxDepth !== undefined) kvItems.push({ key: "maxDepth", value: String(maxDepth) });

  return {
    inputSummary,
    outputSummary: summarizeCount(nodes.length, "root node"),
    blocks: [
      ...(kvItems.length > 0 ? [{ type: "key_value" as const, title: "Level browse", items: kvItems }] : []),
      { type: "tree", title: "Level tree", nodes },
    ],
  };
}

export function buildScriptAddRender(
  args: Record<string, unknown>,
  output: string,
  addedGuid?: string,
): ToolRenderPayload {
  const className = readString(args.class) ?? "Script";
  const scriptName = readString(args.name) ?? "unnamed";
  const parentGuid = readString(args.parentGuid) ?? "";
  const source = readString(args.source) ?? "";
  const targetGuid = addedGuid?.trim() || "new-script";
  return {
    inputSummary: clip(`${className} ${scriptName}`),
    outputSummary: summarizeText(output, "Script added."),
    blocks: [
      {
        type: "diff",
        files: [
          {
            filePath: buildScriptVirtualPath(targetGuid, scriptName),
            action: "Add",
            hunks: [{ newString: source || undefined }],
          },
        ],
        output: firstLine(output, "Script added."),
      },
      {
        type: "key_value",
        title: "Studio script add",
        items: [
          { key: "guid", value: targetGuid },
          { key: "class", value: className },
          { key: "name", value: scriptName },
          { key: "parentGuid", value: parentGuid },
        ].filter((item) => item.value.length > 0),
      },
    ],
  };
}

export function buildDeleteRender(title: string, targetGuid: string, output: string): ToolRenderPayload {
  return {
    inputSummary: clip(targetGuid || title),
    outputSummary: summarizeText(output, "Deleted."),
    blocks: [
      { type: "key_value", title, items: [{ key: "targetGuid", value: targetGuid }] },
      { type: "summary", text: firstLine(output, "Deleted."), tone: "warning" },
    ],
  };
}

export function buildInstanceDeleteRender(args: Record<string, unknown>, output: string): ToolRenderPayload {
  const items = Array.isArray(args.items) ? args.items : [];
  const targetGuids = items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const guid = readString(item.targetGuid);
    return guid ? [guid] : [];
  });
  const deleteCount = targetGuids.length;
  const inputSummary = summarizeTargets(targetGuids, "delete");

  return {
    inputSummary: clip(inputSummary),
    outputSummary: summarizeText(output, "Deleted."),
    blocks: [
      {
        type: "key_value",
        title: "Studio instance delete",
        items: [
          { key: "deletes", value: String(deleteCount) },
          ...targetGuids.map((guid, index) => ({ key: `target${index + 1}`, value: guid })),
        ],
      },
      { type: "summary", text: firstLine(output, "Deleted."), tone: "warning" },
    ],
  };
}

export function buildInstanceAddRender(args: Record<string, unknown>, output: string): ToolRenderPayload {
  const className = readString(args.class) ?? "Instance";
  const instanceName = readString(args.name) ?? "unnamed";
  return {
    inputSummary: clip(`${className} ${instanceName}`),
    outputSummary: summarizeText(output, "Instance added."),
    blocks: [
      {
        type: "key_value",
        title: "Studio instance add",
        items: [
          { key: "class", value: className },
          { key: "name", value: instanceName },
          { key: "parent", value: readString(args.parentGuid) ?? "" },
        ].filter((item) => item.value.length > 0),
      },
      { type: "summary", text: firstLine(output, "Instance added."), tone: "success" },
    ],
  };
}

export function buildGamePlayRender(args: Record<string, unknown>, output: string): ToolRenderPayload {
  const count = typeof args.numberOfPlayer === "number" ? String(args.numberOfPlayer) : "1";
  return {
    inputSummary: `players: ${count}`,
    outputSummary: summarizeText(output, "Game started."),
    blocks: [
      { type: "key_value", title: "Studio play", items: [{ key: "players", value: count }] },
      { type: "summary", text: firstLine(output, "Game started."), tone: "success" },
    ],
  };
}

export function buildGameStopRender(output: string): ToolRenderPayload {
  return {
    inputSummary: "stop game",
    outputSummary: summarizeText(output, "Game stopped."),
    blocks: [{ type: "summary", text: firstLine(output, "Game stopped."), tone: "warning" }],
  };
}

export function buildAssetDrawerImportRender(args: Record<string, unknown>, output: string): ToolRenderPayload {
  const assetId = readString(args.assetid) ?? "";
  const assetName = readString(args.assetName) ?? "unnamed";
  const assetType = readString(args.assetType) ?? "MODEL";
  return {
    inputSummary: clip(`${assetType} ${assetName}`),
    outputSummary: summarizeText(output, "Asset imported."),
    blocks: [
      {
        type: "key_value",
        title: "Asset Drawer import",
        items: [
          { key: "assetName", value: assetName },
          { key: "assetType", value: assetType },
          { key: "assetid", value: assetId },
        ].filter((item) => item.value.length > 0),
      },
      { type: "summary", text: firstLine(output, "Asset imported."), tone: "success" },
    ],
  };
}

export function buildAssetManagerImageImportRender(
  result: unknown,
  args: Record<string, unknown>,
  output: string,
): ToolRenderPayload {
  const file = readString(args.file) ?? "";
  const asset = isRecord(result) && isRecord(result.asset) ? result.asset : undefined;
  const returnedAssetId = asset ? readString(asset.assetid) : undefined;
  const returnedFile = asset ? readString(asset.file) : undefined;
  return {
    inputSummary: clip(file || "image file"),
    outputSummary: summarizeText(output, returnedAssetId ? `Imported as ${returnedAssetId}` : "Image imported."),
    blocks: [
      {
        type: "key_value",
        title: "Asset manager image import",
        items: [
          { key: "file", value: returnedFile ?? file },
          { key: "assetid", value: returnedAssetId ?? "" },
        ].filter((item) => item.value.length > 0),
      },
      {
        type: "summary",
        text: firstLine(output, returnedAssetId ? `Imported as ${returnedAssetId}` : "Image imported."),
        tone: "success",
      },
    ],
  };
}

export function buildLevelSaveFileRender(output: string): ToolRenderPayload {
  return {
    inputSummary: "save current world",
    outputSummary: summarizeText(output, "World file saved."),
    blocks: [{ type: "summary", text: firstLine(output, "World file saved."), tone: "success" }],
  };
}

export function buildInstanceReadRender(args: Record<string, unknown>, output: string): ToolRenderPayload {
  const guid = readString(args.guid) ?? "";
  const recursive = args.recursive === true;
  return {
    inputSummary: clip(guid || "instance read"),
    outputSummary: summarizeText(output, "Instance read."),
    blocks: [
      {
        type: "key_value",
        title: "Studio instance read",
        items: [
          { key: "guid", value: guid },
          { key: "recursive", value: String(recursive) },
        ].filter((item) => item.value.length > 0),
      },
      { type: "summary", text: firstLine(output, "Instance read."), tone: "info" },
    ],
  };
}

export function buildInstanceUpsertRender(args: Record<string, unknown>, output: string): ToolRenderPayload {
  const items = Array.isArray(args.items) ? args.items : [];
  const addCount = items.filter((i) => isRecord(i) && "parentGuid" in i).length;
  const updateCount = items.filter((i) => isRecord(i) && "guid" in i && !("parentGuid" in i)).length;
  const parts: string[] = [];
  if (addCount > 0) parts.push(summarizeCount(addCount, "add"));
  if (updateCount > 0) parts.push(summarizeCount(updateCount, "update"));
  const summary = parts.join(", ") || "upsert";
  return {
    inputSummary: clip(summary),
    outputSummary: summarizeText(output, "Instances upserted."),
    blocks: [
      {
        type: "key_value",
        title: "Studio instance upsert",
        items: [
          { key: "adds", value: String(addCount) },
          { key: "updates", value: String(updateCount) },
        ],
      },
      { type: "summary", text: firstLine(output, "Instances upserted."), tone: "success" },
    ],
  };
}

export function buildInstanceMoveRender(args: Record<string, unknown>, output: string): ToolRenderPayload {
  const items = Array.isArray(args.items) ? args.items : [];
  const moveCount = items.filter(
    (item) => isRecord(item) && readString(item.guid) && readString(item.parentGuid),
  ).length;

  return {
    inputSummary: clip(moveCount > 0 ? summarizeCount(moveCount, "move") : "move"),
    outputSummary: summarizeText(output, "Instances moved."),
    blocks: [
      {
        type: "key_value",
        title: "Studio instance move",
        items: [{ key: "moves", value: String(moveCount) }],
      },
      { type: "summary", text: firstLine(output, "Instances moved."), tone: "success" },
    ],
  };
}

export function buildScriptGrepRender(pattern: string, matchCount: number, scriptsSearched: number): ToolRenderPayload {
  return {
    inputSummary: clip(`grep ${pattern}`),
    outputSummary: matchCount === 0 ? "no matches" : `${matchCount} match${matchCount === 1 ? "" : "es"}`,
    blocks: [
      {
        type: "key_value",
        title: "Studio script grep",
        items: [
          { key: "pattern", value: pattern },
          { key: "matches", value: String(matchCount) },
          { key: "scripts searched", value: String(scriptsSearched) },
        ],
      },
      ...(matchCount === 0 ? [{ type: "summary" as const, text: "No matches found.", tone: "info" as const }] : []),
    ],
  };
}

export function buildScriptReadRender(args: {
  targetGuid: string;
  scriptName: string;
  lineCount: number;
  content: string;
  offset?: number;
  limit?: number;
}): ToolRenderPayload {
  return {
    inputSummary: clip(args.scriptName || args.targetGuid),
    outputSummary: `${args.lineCount} line${args.lineCount === 1 ? "" : "s"} read`,
    blocks: [
      {
        type: "file",
        filePath: buildScriptVirtualPath(args.targetGuid, args.scriptName),
        content: args.content,
        offset: args.offset,
        limit: args.limit,
      },
      {
        type: "key_value",
        title: "Studio script read",
        items: [
          { key: "guid", value: args.targetGuid },
          { key: "name", value: args.scriptName },
          { key: "lines", value: String(args.lineCount) },
        ],
      },
    ],
  };
}

export function buildScriptEditRender(
  args: { targetGuid: string; scriptName?: string; old_string: string; new_string: string; replace_all: boolean },
  output: string,
  count: number,
): ToolRenderPayload {
  return {
    inputSummary: clip(args.scriptName || args.targetGuid),
    outputSummary: `${count} edit${count === 1 ? "" : "s"} applied`,
    blocks: [
      {
        type: "diff",
        files: [
          {
            filePath: buildScriptVirtualPath(args.targetGuid, args.scriptName),
            action: "Update",
            hunks: [{ oldString: args.old_string || undefined, newString: args.new_string }],
          },
        ],
        output: firstLine(output, "Script edited."),
      },
      {
        type: "key_value",
        title: "Studio script edit",
        items: [
          { key: "guid", value: args.targetGuid },
          ...(args.scriptName ? [{ key: "name", value: args.scriptName }] : []),
          { key: "replacements", value: String(count) },
          ...(args.replace_all ? [{ key: "replace_all", value: "true" }] : []),
        ],
      },
    ],
  };
}

function maskToken(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)} (len=${token.length})`;
}

export function buildHubTokenReadRender(result: unknown, output: string): ToolRenderPayload {
  const token = isRecord(result) ? readString(result.token) : undefined;
  const masked = token ? maskToken(token) : "(missing)";
  return {
    inputSummary: "read hub token",
    outputSummary: token ? `token ${masked}` : "no token",
    blocks: [
      {
        type: "key_value",
        title: "Hub token read",
        items: [{ key: "token", value: masked }],
      },
      {
        type: "summary",
        text: token
          ? "Token retrieved. Treat as a secret — do not echo to chat."
          : firstLine(output, "No token returned."),
        tone: token ? "info" : "warning",
      },
    ],
  };
}

export function buildLevelPublishRender(
  _result: unknown,
  args: Record<string, unknown>,
  output: string,
): ToolRenderPayload {
  const worldName = readString(args.worldName);
  const description = readString(args.description);
  const categories = Array.isArray(args.category)
    ? (args.category as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const keywords = Array.isArray(args.keyword)
    ? (args.keyword as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  const items: { key: string; value: string }[] = [];
  if (worldName) items.push({ key: "worldName", value: worldName });
  if (description) items.push({ key: "description", value: description });
  if (categories.length > 0) items.push({ key: "category", value: categories.join(", ") });
  if (keywords.length > 0) items.push({ key: "keyword", value: keywords.join(", ") });

  return {
    inputSummary: clip(worldName ? `publish ${worldName}` : "publish world"),
    outputSummary: summarizeText(output, "Publish requested. Approve in browser to finalize."),
    blocks: [
      ...(items.length > 0 ? [{ type: "key_value" as const, title: "Level publish", items }] : []),
      {
        type: "summary",
        text: firstLine(output, "Studio is opening the web approval page — finalize publish there."),
        tone: "success",
      },
    ],
  };
}

export function buildGameScreenshotRender(
  result: unknown,
  args: Record<string, unknown>,
  output: string,
): ToolRenderPayload {
  const captureType = readString(args.captureType) ?? "Viewport";
  const size = isRecord(args.size) ? args.size : undefined;
  const width = size && typeof size.width === "number" ? size.width : undefined;
  const height = size && typeof size.height === "number" ? size.height : undefined;
  const path = isRecord(result) ? readString(result.path) : undefined;

  const items: { key: string; value: string }[] = [{ key: "captureType", value: captureType }];
  if (width !== undefined && height !== undefined) {
    items.push({ key: "size", value: `${width}×${height}` });
  }
  if (path) items.push({ key: "path", value: path });

  return {
    inputSummary: clip(`screenshot ${captureType}`),
    outputSummary: path ? `saved: ${path}` : summarizeText(output, "Screenshot captured."),
    blocks: [
      { type: "key_value", title: "Game screenshot", items },
      {
        type: "summary",
        text: path ? `Saved to ${path}` : firstLine(output, "Screenshot captured."),
        tone: "success",
      },
    ],
  };
}

export function buildActionSequencerApplyJsonRender(args: Record<string, unknown>, output: string): ToolRenderPayload {
  const instanceGuid = readString(args.instanceGuid) ?? "";
  const jsonFilePath = readString(args.jsonFilePath) ?? "";
  return {
    inputSummary: clip(jsonFilePath || instanceGuid || "apply sequencer json"),
    outputSummary: summarizeText(output, "Sequencer JSON applied."),
    blocks: [
      {
        type: "key_value",
        title: "Action sequencer apply JSON",
        items: [
          { key: "instanceGuid", value: instanceGuid },
          { key: "jsonFilePath", value: jsonFilePath },
        ].filter((item) => item.value.length > 0),
      },
      { type: "summary", text: firstLine(output, "Sequencer JSON applied."), tone: "success" },
    ],
  };
}
