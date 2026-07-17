// @summary Runtime temp-filesystem adapter for full tool outputs truncated by core

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolOutputStore } from "@diligent/core/tool-contract";

export const toolOutputStore: ToolOutputStore = {
  async save(output) {
    const dir = await mkdtemp(join(tmpdir(), "diligent-"));
    const filePath = join(dir, "full-output.txt");
    await writeFile(filePath, output, "utf-8");
    return filePath;
  },
};
