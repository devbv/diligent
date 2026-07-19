// @summary Tests for loadRuntimeConfig happy-path: model, mode, compaction defaults, and streamFunction

import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig } from "@diligent/runtime";

const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-5";

function makeTmpEnv(base: string) {
  const knowledge = join(base, ".diligent", "knowledge");
  const sessions = join(base, ".diligent", "sessions");
  const skills = join(base, ".diligent", "skills");
  mkdirSync(knowledge, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  mkdirSync(skills, { recursive: true });
  return {
    root: join(base, ".diligent"),
    sessions,
    knowledge,
    skills,
    images: join(base, ".diligent", "images"),
  };
}

test("loads model from config.jsonc and returns required fields", async () => {
  const base = join(tmpdir(), `diligent-web-test-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  const paths = makeTmpEnv(base);

  await Bun.write(
    join(base, ".diligent", "config.jsonc"),
    JSON.stringify({ model: { provider: "anthropic", modelId: TEST_ANTHROPIC_MODEL_ID } }),
  );

  const origHome = process.env.HOME;
  process.env.HOME = base;
  try {
    const config = await loadRuntimeConfig(base, paths);

    expect(config.model!.modelId).toBe(TEST_ANTHROPIC_MODEL_ID);
    expect(config.authStore.mode).toBe("auto");
    expect(typeof config.streamFunction).toBe("function");
    expect(Array.isArray(config.systemPrompt)).toBe(true);
    expect(config.systemPrompt.length).toBeGreaterThan(0);
  } finally {
    process.env.HOME = origHome;
    rmSync(base, { recursive: true, force: true });
  }
});

test("compaction defaults when not configured", async () => {
  const base = join(tmpdir(), `diligent-web-test-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  const paths = makeTmpEnv(base);

  await Bun.write(join(base, ".diligent", "config.jsonc"), JSON.stringify({ model: TEST_ANTHROPIC_MODEL_ID }));

  const origHome = process.env.HOME;
  process.env.HOME = base;
  try {
    const config = await loadRuntimeConfig(base, paths);

    expect(config.compaction.enabled).toBe(true);
    expect(config.compaction.reservePercent).toBe(14);
  } finally {
    process.env.HOME = origHome;
    rmSync(base, { recursive: true, force: true });
  }
});

test("mode defaults to default when not configured", async () => {
  const base = join(tmpdir(), `diligent-web-test-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  const paths = makeTmpEnv(base);

  await Bun.write(join(base, ".diligent", "config.jsonc"), JSON.stringify({ model: TEST_ANTHROPIC_MODEL_ID }));

  const origHome = process.env.HOME;
  process.env.HOME = base;
  try {
    const config = await loadRuntimeConfig(base, paths);
    expect(config.mode).toBe("default");
  } finally {
    process.env.HOME = origHome;
    rmSync(base, { recursive: true, force: true });
  }
});
