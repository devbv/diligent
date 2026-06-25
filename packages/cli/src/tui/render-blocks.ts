// @summary Terminal text renderer for P040 ToolRenderPayload structured blocks
import type {
  AssetGalleryBlock,
  CommandBlock,
  DiffBlock,
  DiffFile,
  DiffHunk,
  FileBlock,
  KeyValueBlock,
  ListBlock,
  StatusBadgesBlock,
  SummaryBlock,
  TableBlock,
  ToolRenderBlock,
  ToolRenderPayload,
  ToolRenderTextBlock,
  TreeBlock,
  TreeNode,
} from "@diligent/protocol";
import { t } from "./theme";

const FILE_PREVIEW_LINES = 15;
const COMMAND_PREVIEW_LINES = 15;
const DIFF_PREVIEW_LINES = 12;

function toneAnsi(tone?: string): string {
  switch (tone) {
    case "success":
      return t.success;
    case "warning":
      return t.warn;
    case "danger":
      return t.error;
    case "info":
      return t.accent;
    default:
      return "";
  }
}

function blockTitle(title?: string): string[] {
  if (!title) return [];
  return [`${t.bold}${title}${t.reset}`];
}

function renderSummary(block: SummaryBlock): string[] {
  const color = toneAnsi(block.tone);
  return [`${color}${block.text}${t.reset}`];
}

function renderText(block: ToolRenderTextBlock): string[] {
  const lines: string[] = [...blockTitle(block.title)];
  const color = block.isError ? t.error : t.dim;
  for (const line of block.text.split("\n")) {
    lines.push(`${color}${lines.length > 0 ? "  " : ""}${line}${t.reset}`);
  }
  return lines;
}

function renderKeyValue(block: KeyValueBlock): string[] {
  const lines: string[] = [...blockTitle(block.title)];
  const maxKeyLen = block.items.reduce((max, item) => Math.max(max, item.key.length), 0);
  for (const item of block.items) {
    const paddedKey = item.key.padEnd(maxKeyLen);
    lines.push(`  ${t.dim}${paddedKey}${t.reset}  ${item.value}`);
  }
  return lines;
}

function renderList(block: ListBlock): string[] {
  const lines: string[] = [...blockTitle(block.title)];
  block.items.forEach((item, index) => {
    const bullet = block.ordered ? `${index + 1}.` : "•";
    lines.push(`  ${t.dim}${bullet}${t.reset} ${item}`);
  });
  return lines;
}

function renderTable(block: TableBlock): string[] {
  const lines: string[] = [...blockTitle(block.title)];
  if (block.columns.length === 0) return lines;

  const colWidths = block.columns.map((column, columnIndex) => {
    const maxRowLen = block.rows.reduce((max, row) => Math.max(max, (row[columnIndex] ?? "").length), 0);
    return Math.max(column.length, maxRowLen);
  });

  const formatRow = (cells: string[]) =>
    cells.map((cell, columnIndex) => cell.padEnd(colWidths[columnIndex] ?? 0)).join("  ");

  lines.push(`  ${t.bold}${formatRow(block.columns)}${t.reset}`);
  const separator = colWidths.map((width) => "─".repeat(width)).join("  ");
  lines.push(`  ${t.dim}${separator}${t.reset}`);

  for (const row of block.rows) {
    const cells = block.columns.map((_, columnIndex) => row[columnIndex] ?? "");
    lines.push(`  ${formatRow(cells)}`);
  }

  return lines;
}

function renderAssetGallery(block: AssetGalleryBlock): string[] {
  const lines: string[] = [...blockTitle(block.title ?? "Assets")];
  const resultLabel = `${block.items.length} result${block.items.length === 1 ? "" : "s"}`;
  lines.push(`  ${t.dim}${block.query ? `${resultLabel} for "${block.query}"` : resultLabel}${t.reset}`);

  block.items.forEach((item, index) => {
    const price = item.price ? `${t.dim}[${item.price}]${t.reset} ` : "";
    const subtitle = item.subtitle ? `${t.dim} ${item.subtitle}${t.reset}` : "";
    const id = item.id ? `${t.dim} (${item.id})${t.reset}` : "";
    lines.push(`  ${index + 1}. ${price}${item.title}${subtitle}${id}`);
  });

  return lines;
}

function renderTreeNode(node: TreeNode, prefix: string, isLast: boolean): string[] {
  const connector = isLast ? "└─ " : "├─ ";
  const lines: string[] = [`${t.dim}${prefix}${connector}${t.reset}${node.label}`];
  const children = node.children as TreeNode[] | undefined;
  if (children && children.length > 0) {
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    children.forEach((child, index) => {
      lines.push(...renderTreeNode(child, childPrefix, index === children.length - 1));
    });
  }
  return lines;
}

function renderTree(block: TreeBlock): string[] {
  const lines: string[] = [...blockTitle(block.title)];
  const nodes = block.nodes as TreeNode[];
  nodes.forEach((node, index) => {
    lines.push(...renderTreeNode(node, "  ", index === nodes.length - 1));
  });
  return lines;
}

function renderStatusBadges(block: StatusBadgesBlock): string[] {
  const lines: string[] = [...blockTitle(block.title)];
  const badges = block.items
    .map((item) => {
      const color = toneAnsi(item.tone);
      return `${color}[${item.label}]${t.reset}`;
    })
    .join("  ");
  lines.push(`  ${badges}`);
  return lines;
}

function truncateLines(lines: string[], maxLines: number): { visibleLines: string[]; hiddenCount: number } {
  if (lines.length <= maxLines) return { visibleLines: lines, hiddenCount: 0 };
  const visibleLines = lines.slice(0, maxLines);
  return { visibleLines, hiddenCount: lines.length - maxLines };
}

function renderFile(block: FileBlock): string[] {
  const rangeLabel =
    block.offset && block.limit
      ? `L${block.offset}-${block.offset + block.limit - 1}`
      : block.offset
        ? `from L${block.offset}`
        : block.limit
          ? `${block.limit} lines`
          : "";

  const headerParts = [`${t.accent}↗${t.reset}`, block.filePath];
  if (rangeLabel) headerParts.push(`${t.dim}${rangeLabel}${t.reset}`);
  const lines: string[] = [headerParts.join(" ")];

  if (!block.content) {
    if (block.isError) lines.push(`${t.error}  (error)${t.reset}`);
    return lines;
  }

  const contentLines = block.content.split("\n");
  const { visibleLines, hiddenCount } = truncateLines(contentLines, FILE_PREVIEW_LINES);
  const color = block.isError ? t.error : t.dim;

  for (const line of visibleLines) {
    lines.push(`${color}  ${line}${t.reset}`);
  }

  if (hiddenCount > 0) {
    lines.push(`${t.dim}  … +${hiddenCount} lines${t.reset}`);
  }

  return lines;
}

function renderCommand(block: CommandBlock): string[] {
  const lines: string[] = [`${t.dim}$${t.reset} ${block.command}`];
  if (!block.output) return lines;

  const outputLines = block.output.split("\n");
  const { visibleLines, hiddenCount } = truncateLines(outputLines, COMMAND_PREVIEW_LINES);
  const color = block.isError ? t.error : t.dim;

  for (const line of visibleLines) {
    lines.push(`${color}  ${line}${t.reset}`);
  }

  if (hiddenCount > 0) {
    lines.push(`${t.dim}  … +${hiddenCount} lines${t.reset}`);
  }

  return lines;
}

function renderDiffHunk(hunk: DiffHunk): string[] {
  const lines: string[] = [];

  if (hunk.oldString) {
    const oldLines = hunk.oldString.split("\n");
    const { visibleLines, hiddenCount } = truncateLines(oldLines, DIFF_PREVIEW_LINES);
    for (const line of visibleLines) {
      lines.push(`${t.error}  - ${line}${t.reset}`);
    }
    if (hiddenCount > 0) {
      lines.push(`${t.dim}    … +${hiddenCount} old lines${t.reset}`);
    }
  }

  if (hunk.newString !== undefined) {
    const newLines = hunk.newString.split("\n");
    const { visibleLines, hiddenCount } = truncateLines(newLines, DIFF_PREVIEW_LINES);
    for (const line of visibleLines) {
      lines.push(`${t.success}  + ${line}${t.reset}`);
    }
    if (hiddenCount > 0) {
      lines.push(`${t.dim}    … +${hiddenCount} new lines${t.reset}`);
    }
  }

  return lines;
}

function renderDiffFile(file: DiffFile): string[] {
  const action = file.action ?? "Update";
  const actionColor =
    action === "Add" ? t.success : action === "Delete" ? t.error : action === "Move" ? t.warn : t.accent;
  const path = action === "Move" && file.movedTo ? `${file.filePath} -> ${file.movedTo}` : file.filePath;

  const lines: string[] = [`${t.accent}✎${t.reset} ${path} ${actionColor}[${action}]${t.reset}`];
  for (const hunk of file.hunks) {
    lines.push(...renderDiffHunk(hunk));
  }
  return lines;
}

function renderDiff(block: DiffBlock): string[] {
  const lines: string[] = [];
  block.files.forEach((file, index) => {
    if (index > 0) lines.push("");
    lines.push(...renderDiffFile(file));
  });
  if (block.output) {
    const firstLine = block.output.split("\n")[0] ?? "";
    if (firstLine.trim()) {
      const color = block.isError ? t.error : t.dim;
      lines.push(`${color}${firstLine}${t.reset}`);
    }
  }
  return lines;
}

function safeStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function renderUnknownBlock(block: unknown): string[] {
  const value = block as { type?: unknown; title?: unknown };
  const type = safeStringValue(value?.type) || "unknown";
  const title = safeStringValue(value?.title);
  const label = title ? `${type} — ${title}` : type;
  return [`${t.dim}[unsupported block] ${label}${t.reset}`];
}

function renderBlock(block: ToolRenderBlock): string[] {
  switch (block.type) {
    case "summary":
      return renderSummary(block);
    case "text":
      return renderText(block);
    case "key_value":
      return renderKeyValue(block);
    case "list":
      return renderList(block);
    case "table":
      return renderTable(block);
    case "asset_gallery":
      return renderAssetGallery(block);
    case "tree":
      return renderTree(block);
    case "status_badges":
      return renderStatusBadges(block);
    case "file":
      return renderFile(block);
    case "command":
      return renderCommand(block);
    case "diff":
      return renderDiff(block);
    default:
      return renderUnknownBlock(block);
  }
}

export function renderToolPayload(payload: ToolRenderPayload | undefined): string[] {
  if (!payload || payload.blocks.length === 0) return [];
  const lines: string[] = [];
  for (const block of payload.blocks) {
    let blockLines: string[];
    try {
      blockLines = renderBlock(block);
    } catch {
      blockLines = [`${t.dim}[render error] ${(block as { type?: unknown })?.type ?? "unknown"}${t.reset}`];
    }
    if (blockLines.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(...blockLines);
    }
  }
  return lines;
}
