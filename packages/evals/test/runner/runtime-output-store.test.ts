// @summary Deterministic ownership and bounded-read tests for the runtime eval output store

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "@diligent/runtime";
import { createRuntimeEvalOutputStore } from "../../src/runner/runtime-output-store";
import { transformRuntimeTools } from "../../src/runner/runtime-tool-policy";
import { removeTemporaryRoot } from "../../src/runner/runtime-workspace";

describe("runtime eval output-store ownership", () => {
  test("allows one registered bounded round-trip and rejects forged, unregistered, out-of-root, and oversized reads", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    const outputRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-output-"));
    try {
      const outputStore = createRuntimeEvalOutputStore(outputRoot);
      const registered = await outputStore.store.save("line one\nline two\nline three\n");
      const [read] = transformRuntimeTools({
        tools: [createReadTool()],
        root: workspace,
        traces: [],
        maxToolCalls: 10,
        maxUserInputRequests: 0,
        maxChildAgents: 0,
        policy: { allowedTools: ["read"], allowedCapabilities: ["read"], allowedCommands: [] },
        registeredReadPaths: outputStore.registeredPaths,
        isTerminated: () => false,
        onBudgetExceeded: () => {},
      });

      expect(await read!.execute({ file_path: registered, offset: 2, limit: 1 }, {} as never)).toMatchObject({
        output: "2\tline two\n\n... (showing lines 2-2 of 4 total)",
      });

      for (const input of [
        { file_path: `${registered}.forged`, offset: 1, limit: 1 },
        { file_path: join(outputRoot, "unregistered.txt"), offset: 1, limit: 1 },
        { file_path: "/tmp/diligent-unowned-output.txt", offset: 1, limit: 1 },
        { file_path: registered, offset: 1, limit: 2_001 },
      ]) {
        const result = await read!.execute(input, {} as never);
        expect(result.metadata).toMatchObject({ error: true, runtimeEvalRejected: true });
      }
    } finally {
      await removeTemporaryRoot(workspace);
      await removeTemporaryRoot(outputRoot);
    }
  });
});
