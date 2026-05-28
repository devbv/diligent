// @summary Shared utilities for reading and navigating .ovdrjm level files.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

export type OvdrjmNode = Record<string, unknown> & {
  ActorGuid?: unknown;
  LuaChildren?: unknown;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function findNodeByActorGuid(node: OvdrjmNode, targetGuid: string): OvdrjmNode | undefined {
  if (typeof node.ActorGuid === "string" && node.ActorGuid === targetGuid) {
    return node;
  }
  if (!Array.isArray(node.LuaChildren)) {
    return undefined;
  }
  for (const child of node.LuaChildren) {
    if (!isRecord(child)) continue;
    const found = findNodeByActorGuid(child as OvdrjmNode, targetGuid);
    if (found) return found;
  }
  return undefined;
}

export function removeNodeByActorGuid(node: OvdrjmNode, targetGuid: string): boolean {
  if (!Array.isArray(node.LuaChildren)) return false;
  const children = node.LuaChildren as OvdrjmNode[];
  const index = children.findIndex((child) => isRecord(child) && child.ActorGuid === targetGuid);
  if (index !== -1) {
    children.splice(index, 1);
    return true;
  }
  for (const child of children) {
    if (isRecord(child) && removeNodeByActorGuid(child as OvdrjmNode, targetGuid)) {
      return true;
    }
  }
  return false;
}

export function findFilesByExtension(cwd: string, extension: string): string[] {
  const entries = readdirSync(cwd, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => join(cwd, entry.name));
}

export function resolveOvdrjmPathFromUmap(cwd: string): { umapPath: string; ovdrjmPath: string } {
  const umapFiles = findFilesByExtension(cwd, ".umap");
  if (umapFiles.length === 0) {
    throw new Error("No .umap file found in current working directory.");
  }
  if (umapFiles.length > 1) {
    throw new Error(
      `Multiple .umap files found (${umapFiles.map((file) => file.split("/").pop()).join(", ")}). Keep one world file in cwd.`,
    );
  }

  const umapPath = umapFiles[0];
  const ovdrjmPath = umapPath.replace(/\.umap$/i, ".ovdrjm");

  const ovdrjmFiles = findFilesByExtension(cwd, ".ovdrjm");
  if (!ovdrjmFiles.includes(ovdrjmPath)) {
    throw new Error(
      `Matching .ovdrjm file not found for ${umapPath.split("/").pop()}. Expected ${ovdrjmPath.split("/").pop()}.`,
    );
  }

  return { umapPath, ovdrjmPath };
}

export function readOvdrjmRoot(cwd: string): { umapPath: string; ovdrjmPath: string; root: OvdrjmNode } {
  const { umapPath, ovdrjmPath } = resolveOvdrjmPathFromUmap(cwd);
  const buf = readFileSync(ovdrjmPath);
  const raw = buf[0] === 0xff && buf[1] === 0xfe ? new TextDecoder("utf-16le").decode(buf) : buf.toString("utf-8");
  const parsedJson = JSON.parse(raw) as Record<string, unknown>;
  const root = parsedJson.Root;
  if (!isRecord(root)) {
    throw new Error("Invalid .ovdrjm format: Root object is missing.");
  }
  return { umapPath, ovdrjmPath, root: root as OvdrjmNode };
}

function isUtf16Le(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
}

function decodeOvdrjm(buf: Buffer): string {
  return isUtf16Le(buf) ? new TextDecoder("utf-16le").decode(buf) : buf.toString("utf-8");
}

function encodeOvdrjm(text: string, originalBuf: Buffer): Buffer {
  if (isUtf16Le(originalBuf)) {
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(text, "utf16le");
    return Buffer.concat([bom, body]);
  }
  return Buffer.from(text, "utf-8");
}

/**
 * Normalize line endings to match the current OS convention.
 * Windows → \r\n, others → \n.
 * Returns { result, converted } where `converted` is the number of line
 * endings that were changed.
 */
export function normalizeLineEndings(source: string): { result: string; converted: number } {
  const isWindows = platform() === "win32";
  if (isWindows) {
    // First normalize everything to \n, then convert to \r\n
    const unified = source.replace(/\r\n/g, "\n");
    const converted = unified.split("\n").length - 1 - (source.match(/\r\n/g)?.length ?? 0);
    const result = unified.replace(/\n/g, "\r\n");
    return { result, converted };
  }
  // Non-Windows: strip \r from \r\n
  let converted = 0;
  const result = source.replace(/\r\n/g, () => {
    converted++;
    return "\n";
  });
  return { result, converted };
}

/**
 * Normalize leading indentation: convert every 4 consecutive spaces in the
 * leading whitespace region of each line into a tab character.
 * Returns { result, converted } where `converted` is the number of 4-space
 * groups that were replaced across all lines.
 */
export function normalizeLeadingSpaces(source: string): { result: string; converted: number } {
  let converted = 0;
  const result = source.replace(/^[\t ]*/gm, (leading) => {
    let out = "";
    let spaces = 0;
    for (const ch of leading) {
      if (ch === "\t") {
        if (spaces > 0) {
          out += " ".repeat(spaces);
          spaces = 0;
        }
        out += "\t";
      } else {
        spaces++;
        if (spaces === 4) {
          out += "\t";
          converted++;
          spaces = 0;
        }
      }
    }
    if (spaces > 0) out += " ".repeat(spaces);
    return out;
  });
  return { result, converted };
}

export function readAndWriteOvdrjm<T>(
  cwd: string,
  update: (rootDoc: Record<string, unknown>) => T,
): { umapPath: string; ovdrjmPath: string } & T {
  const { umapPath, ovdrjmPath } = resolveOvdrjmPathFromUmap(cwd);
  const buf = readFileSync(ovdrjmPath);
  const raw = decodeOvdrjm(buf);
  const parsedJson = JSON.parse(raw) as Record<string, unknown>;
  const outcome = update(parsedJson);
  const output = `${JSON.stringify(parsedJson, null, 2)}\n`;
  writeFileSync(ovdrjmPath, encodeOvdrjm(output, buf));
  return { umapPath, ovdrjmPath, ...outcome };
}
