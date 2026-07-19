// @summary Eval-owned exact-file store for full truncated tool outputs and bounded report metadata

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolOutputFileStore } from "@diligent/core/tool-contract";
import type { RuntimeToolOutputFileEvidence } from "../runtime-task";
import { normalizePlatformAlias, validateTemporaryRoot } from "./runtime-workspace";

export interface RuntimeEvalOutputStore {
  store: ToolOutputFileStore;
  registeredPaths: ReadonlySet<string>;
  files: Array<RuntimeToolOutputFileEvidence & { path: string }>;
}

export function createRuntimeEvalOutputStore(root: string): RuntimeEvalOutputStore {
  const safeRoot = validateTemporaryRoot(root);
  const registeredPaths = new Set<string>();
  const files: Array<RuntimeToolOutputFileEvidence & { path: string }> = [];
  let sequence = 0;
  return {
    registeredPaths,
    files,
    store: {
      async save(output) {
        sequence += 1;
        const path = join(safeRoot, `full-output-${String(sequence).padStart(6, "0")}.txt`);
        await writeFile(path, output, { encoding: "utf8", flag: "wx" });
        const resolved = resolve(path);
        registeredPaths.add(normalizePlatformAlias(resolved));
        files.push({
          path: resolved,
          bytes: Buffer.byteLength(output),
          sha256: createHash("sha256").update(output).digest("hex"),
        });
        return resolved;
      },
    },
  };
}
