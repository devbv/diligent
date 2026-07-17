// @summary Applies codex-style Begin/End patch envelopes with lenient/strict verification
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Tool, ToolResult } from "@diligent/core/tool-contract";
import { z } from "zod";
import { dirnameCrossPlatform, isAbsolute, relativeCrossPlatform, resolveCrossPlatformPath } from "../util/path";
import { type RuntimeToolHost, requestToolApproval } from "./capabilities";
import { createPatchDiffRenderPayload, createTextRenderPayload } from "./render-payload";

const ApplyPatchParams = z.object({
  patch: z.string().describe("The full patch text to apply, including *** Begin Patch and *** End Patch markers"),
});

type PatchHunk =
  | { type: "add"; path: string; lines: string[] }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: UpdateChunk[] };

interface UpdateChunk {
  oldLines: string[];
  newLines: string[];
  context?: string;
  isEndOfFile?: boolean;
}

interface FileChange {
  type: "add" | "update" | "delete" | "move";
  sourcePath: string;
  targetPath: string;
  before: string;
  after: string;
}

interface PatchTouchedPath {
  sourcePath: string;
  targetPath: string;
}

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";

export interface ApplyPatchOptions {
  strict?: boolean;
}

export function createApplyPatchTool(
  cwd: string,
  host?: RuntimeToolHost,
  options?: ApplyPatchOptions,
): Tool<typeof ApplyPatchParams> {
  return {
    name: "apply_patch",
    description: `Use the \`apply_patch\` tool to edit files.
Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by *** Move to: <new path> if you want to rename the file.
Then one or more “hunks”, each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change’s [context_after] lines in the second change’s [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

- If a code block is repeated so many times in a class or function such that even a single \`@@\` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple \`@@\` statements to jump to the right context. For instance:

@@ class BaseClass
@@ \t def method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

The full grammar definition is below:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

A full patch can combine several operations:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file
- File references can only be relative, NEVER ABSOLUTE.`,
    parameters: ApplyPatchParams,
    async execute(args, ctx): Promise<ToolResult> {
      let hunks: PatchHunk[];
      try {
        hunks = parsePatch(args.patch, options);
      } catch (error) {
        const output = `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`;
        return {
          output,
          render: createTextRenderPayload(args.patch, output, true),
          metadata: { error: true },
        };
      }

      if (hunks.length === 0) {
        return {
          output: "patch rejected: empty patch",
          render: createTextRenderPayload(args.patch, "patch rejected: empty patch", true),
          metadata: { error: true },
        };
      }

      let touchedPaths: PatchTouchedPath[];
      try {
        touchedPaths = listTouchedPaths(hunks, cwd);
      } catch (error) {
        const output = `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`;
        return {
          output,
          render: createTextRenderPayload(args.patch, output, true),
          metadata: { error: true },
        };
      }

      const previewPath = touchedPaths[0]?.targetPath ?? touchedPaths[0]?.sourcePath ?? "(none)";
      const approval = await requestToolApproval(host, {
        permission: "write",
        toolName: "apply_patch",
        description: `Apply patch touching ${touchedPaths.length} file(s)`,
        details: {
          file_path: previewPath,
          paths: touchedPaths.map((path) => path.targetPath),
        },
      });
      if (approval === "reject") {
        ctx.abort();
        return {
          output: "[Rejected by user]",
          render: createTextRenderPayload(args.patch, "[Rejected by user]", true),
          metadata: { error: true },
        };
      }

      let changes: FileChange[];
      try {
        changes = await applyHunks(hunks, cwd);
      } catch (error) {
        const output = `Error applying patch: ${error instanceof Error ? error.message : String(error)}`;
        return {
          output,
          render: createTextRenderPayload(args.patch, output, true),
          metadata: { error: true },
        };
      }

      const summaryLines = changes.map((change) => {
        const relSource = normalizeRelPath(relativeCrossPlatform(cwd, change.sourcePath));
        const relTarget = normalizeRelPath(relativeCrossPlatform(cwd, change.targetPath));
        if (change.type === "add") return `A ${relTarget}`;
        if (change.type === "delete") return `D ${relSource}`;
        if (change.type === "move") return `M ${relTarget}`;
        return `M ${relTarget}`;
      });

      const output = `Success. Updated the following files:\n${summaryLines.join("\n")}`;
      return {
        output,
        render: createPatchDiffRenderPayload(
          args.patch,
          output,
          `${changes.length} file${changes.length === 1 ? "" : "s"} patched`,
        ),
      };
    },
  };
}

function normalizeRelPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripShellWrapper(value: string): string {
  // bash -lc "apply_patch <<'EOF'\n...\nEOF"  (literal \n escapes)
  const bashLcLiteralNl = value.match(/^bash\s+-\S*l\S*c\s+"([\s\S]+)"\s*$/);
  if (bashLcLiteralNl) {
    const inner = bashLcLiteralNl[1].replace(/\\n/g, "\n").replace(/\\'/g, "'").replace(/\\"/g, '"');
    return stripShellWrapper(inner);
  }

  // bash -lc 'apply_patch <<'\''EOF'\'' ... EOF'  (actual newlines)
  const bashLcActualNl = value.match(/^bash\s+-\S*l\S*c\s+'([\s\S]+)'\s*$/);
  if (bashLcActualNl) {
    return stripShellWrapper(bashLcActualNl[1].replace(/\\'/g, "'"));
  }

  // [cd /path &&] apply_patch <<'DELIM'\n...\nDELIM
  const applyPatchHeredoc = value.match(
    /(?:^|.*&&\s+)apply_patch\s+<<['"]{0,1}(\w+)['"]{0,1}\s*\n([\s\S]*?)\n\1['"]{0,1}\s*$/,
  );
  if (applyPatchHeredoc) return applyPatchHeredoc[2];

  // cat <<'DELIM'\n...\nDELIM  or bare <<'DELIM'\n...\nDELIM
  const bareHeredoc = value.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  if (bareHeredoc) return bareHeredoc[2];

  return value;
}

export function parsePatch(rawPatch: string, options?: ApplyPatchOptions): PatchHunk[] {
  if (!rawPatch.trim()) throw new Error("patch is empty");

  const trimmed = normalizeNewlines(rawPatch).trim();
  if (options?.strict && stripShellWrapper(trimmed) !== trimmed) {
    throw new Error("Invalid patch format: shell wrapper not allowed in strict mode");
  }
  const normalized = options?.strict ? trimmed : stripShellWrapper(trimmed);
  const lines = normalized.split("\n");
  const begin = lines.findIndex((line) => line.trim() === BEGIN_MARKER);
  const end = lines.findIndex((line) => line.trim() === END_MARKER);

  if (begin === -1 || end === -1 || begin >= end) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  for (let i = 0; i < begin; i++) {
    if (lines[i].trim().length > 0) throw new Error("Unexpected content before *** Begin Patch");
  }
  for (let i = end + 1; i < lines.length; i++) {
    if (lines[i].trim().length > 0) throw new Error("Unexpected content after *** End Patch");
  }

  const hunks: PatchHunk[] = [];
  let i = begin + 1;

  while (i < end) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    if (line.startsWith("*** Add File:")) {
      const path = line.slice("*** Add File:".length).trim();
      if (!path) throw new Error("Missing path in Add File header");
      const addLines: string[] = [];
      i++;
      while (i < end && !lines[i].startsWith("*** ")) {
        if (!lines[i].startsWith("+")) throw new Error(`Invalid Add File line: ${lines[i]}`);
        addLines.push(lines[i].slice(1));
        i++;
      }
      hunks.push({ type: "add", path, lines: addLines });
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      const path = line.slice("*** Delete File:".length).trim();
      if (!path) throw new Error("Missing path in Delete File header");
      hunks.push({ type: "delete", path });
      i++;
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const path = line.slice("*** Update File:".length).trim();
      if (!path) throw new Error("Missing path in Update File header");
      i++;

      let movePath: string | undefined;
      if (i < end && lines[i].startsWith("*** Move to:")) {
        movePath = lines[i].slice("*** Move to:".length).trim();
        if (!movePath) throw new Error("Missing path in Move to header");
        i++;
      }

      const chunks: UpdateChunk[] = [];
      while (i < end && !lines[i].startsWith("*** ")) {
        if (lines[i].trim().length === 0) {
          i++;
          continue;
        }
        if (!lines[i].startsWith("@@")) {
          throw new Error(`Expected @@ hunk header, got: ${lines[i]}`);
        }

        const context = lines[i].slice(2).trim() || undefined;
        i++;
        const oldLines: string[] = [];
        const newLines: string[] = [];
        let isEndOfFile = false;

        while (i < end && !lines[i].startsWith("@@") && !lines[i].startsWith("*** ")) {
          const row = lines[i];
          if (row === "*** End of File") {
            isEndOfFile = true;
            i++;
            break;
          }
          if (row.startsWith(" ")) {
            const value = row.slice(1);
            oldLines.push(value);
            newLines.push(value);
          } else if (row.startsWith("-")) {
            oldLines.push(row.slice(1));
          } else if (row.startsWith("+")) {
            newLines.push(row.slice(1));
          } else {
            throw new Error(`Invalid hunk line: ${row}`);
          }
          i++;
        }

        chunks.push({ oldLines, newLines, context, isEndOfFile: isEndOfFile || undefined });
      }

      hunks.push({ type: "update", path, movePath, chunks });
      continue;
    }

    throw new Error(`Unknown patch header: ${line}`);
  }

  return hunks;
}

function resolvePatchPath(cwd: string, patchPath: string): string {
  if (isAbsolute(patchPath)) {
    throw new Error(`Patch paths must be relative, got absolute path: ${patchPath}`);
  }
  return resolveCrossPlatformPath(cwd, patchPath);
}

function listTouchedPaths(hunks: PatchHunk[], cwd: string): PatchTouchedPath[] {
  return hunks.map((hunk) => {
    const sourcePath = resolvePatchPath(cwd, hunk.path);
    const targetPath = hunk.type === "update" && hunk.movePath ? resolvePatchPath(cwd, hunk.movePath) : sourcePath;
    return { sourcePath, targetPath };
  });
}

async function applyHunks(hunks: PatchHunk[], cwd: string): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  for (const hunk of hunks) {
    if (hunk.type === "add") {
      const targetPath = resolvePatchPath(cwd, hunk.path);
      const before = await readFile(targetPath, "utf-8").catch(() => "");
      const after = hunk.lines.length === 0 ? "" : `${hunk.lines.join("\n")}\n`;

      await mkdir(dirnameCrossPlatform(targetPath), { recursive: true });
      await writeFile(targetPath, after, "utf-8");

      changes.push({
        type: "add",
        sourcePath: targetPath,
        targetPath,
        before,
        after,
      });
      continue;
    }

    if (hunk.type === "delete") {
      const sourcePath = resolvePatchPath(cwd, hunk.path);
      const info = await stat(sourcePath).catch(() => null);
      if (!info || !info.isFile()) {
        throw new Error(`Failed to delete file ${sourcePath}`);
      }
      const before = await readFile(sourcePath, "utf-8");

      await rm(sourcePath);

      changes.push({
        type: "delete",
        sourcePath,
        targetPath: sourcePath,
        before,
        after: "",
      });
      continue;
    }

    const sourcePath = resolvePatchPath(cwd, hunk.path);
    const info = await stat(sourcePath).catch(() => null);
    if (!info || !info.isFile()) {
      throw new Error(`Failed to read file to update: ${sourcePath}`);
    }
    const before = await readFile(sourcePath, "utf-8");
    const after = deriveNewContent(sourcePath, before, hunk.chunks);
    const targetPath = hunk.movePath ? resolvePatchPath(cwd, hunk.movePath) : sourcePath;

    await mkdir(dirnameCrossPlatform(targetPath), { recursive: true });
    await writeFile(targetPath, after, "utf-8");

    if (hunk.movePath && sourcePath !== targetPath) {
      await rm(sourcePath, { force: true });
    }

    changes.push({
      type: hunk.movePath ? "move" : "update",
      sourcePath,
      targetPath,
      before,
      after,
    });
  }

  return changes;
}

function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function deriveNewContent(filePath: string, content: string, chunks: UpdateChunk[]): string {
  const original = splitLines(content);
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.context) {
      const contextIndex = seekSequenceWithFallback(original, [chunk.context], lineIndex);
      if (contextIndex === -1) {
        throw new Error(`Failed to find context '${chunk.context}' in ${filePath}`);
      }
      lineIndex = Math.max(lineIndex, contextIndex + 1);
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex = original.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let found = seekSequenceWithFallback(original, pattern, lineIndex, chunk.isEndOfFile);

    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (replacement.length > 0 && replacement[replacement.length - 1] === "") {
        replacement = replacement.slice(0, -1);
      }
      found = seekSequenceWithFallback(original, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === -1) {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
    }

    replacements.push([found, pattern.length, replacement]);
    lineIndex = Math.max(lineIndex, found + pattern.length);
  }

  replacements.sort((lhs, rhs) => lhs[0] - rhs[0]);

  const next = [...original];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [start, oldLen, newLines] = replacements[i];
    next.splice(start, oldLen, ...newLines);
  }

  if (next.length === 0) return "";
  return `${next.join("\n")}\n`;
}

function seekSequenceWithFallback(lines: string[], pattern: string[], start: number, eof = false): number {
  const primary = seekSequence(lines, pattern, start, eof);
  if (primary !== -1) return primary;
  if (start <= 0) return -1;
  return seekSequence(lines, pattern, 0, eof);
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, " ");
}

function tryMatch(
  lines: string[],
  pattern: string[],
  start: number,
  compare: (a: string, b: string) => boolean,
  eof: boolean,
): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= start) {
      let matched = true;
      for (let i = 0; i < pattern.length; i++) {
        if (!compare(lines[fromEnd + i], pattern[i])) {
          matched = false;
          break;
        }
      }
      if (matched) return fromEnd;
    }
  }

  for (let index = start; index <= lines.length - pattern.length; index++) {
    let matched = true;
    for (let i = 0; i < pattern.length; i++) {
      if (!compare(lines[index + i], pattern[i])) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }

  return -1;
}

function seekSequence(lines: string[], pattern: string[], start: number, eof = false): number {
  if (pattern.length === 0) return -1;

  const exact = tryMatch(lines, pattern, start, (a, b) => a === b, eof);
  if (exact !== -1) return exact;

  const rstrip = tryMatch(lines, pattern, start, (a, b) => a.trimEnd() === b.trimEnd(), eof);
  if (rstrip !== -1) return rstrip;

  const trim = tryMatch(lines, pattern, start, (a, b) => a.trim() === b.trim(), eof);
  if (trim !== -1) return trim;

  return tryMatch(lines, pattern, start, (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()), eof);
}
