// @summary Regression test ensuring spawned sub-agent thread_id matches persisted child session ID
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@diligent/runtime/collab";
import { resolvePaths } from "@diligent/runtime/infrastructure";
import { readSessionFile } from "@diligent/runtime/session";
import { getBuiltinAgentDefinitions } from "../../src/agent/agent-types";
import { makeAssistant, makeStreamFn, TEST_MODEL } from "../helpers/collab";

const TEST_ROOT = join(tmpdir(), `diligent-collab-threadid-${Date.now()}`);

async function setupDir(): Promise<{ cwd: string; paths: ReturnType<typeof resolvePaths> }> {
  const cwd = join(TEST_ROOT, `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const paths = resolvePaths(cwd);
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.knowledge, { recursive: true });
  await mkdir(paths.skills, { recursive: true });
  return { cwd, paths };
}

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("sub-agent thread ID consistency", () => {
  it("spawn thread_id equals child session header.id and file basename", async () => {
    const { cwd, paths } = await setupDir();

    const registry = new AgentRegistry({
      cwd,
      paths,
      model: TEST_MODEL,
      effort: "medium",
      systemPrompt: [{ label: "test", content: "test" }],
      agentDefinitions: getBuiltinAgentDefinitions(),
      parentTools: [],
      streamFn: makeStreamFn([makeAssistant("child complete")]),
    });

    const { threadId } = registry.spawn({
      prompt: "run child task",
      description: "id consistency test",
      agentType: "general",
    });

    await registry.wait([threadId], 10_000);

    const files = (await readdir(paths.sessions)).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const fileBasename = files[0].replace(/\.jsonl$/, "");
    const { header } = await readSessionFile(join(paths.sessions, files[0]));

    expect(threadId).toBe(fileBasename);
    expect(header.id).toBe(threadId);
    expect(header.id).toBe(fileBasename);
  });
});
