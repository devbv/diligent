// @summary Tests for runtime config agent loading and prompt rendering
import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../../src/config/runtime";
import { loadRuntimeConfig } from "../../src/config/runtime";
import type { DiligentPaths } from "../../src/infrastructure";

let tmpRoot = "";
let originalStorageNamespace: string | undefined;

function makePaths(base: string): DiligentPaths {
  return {
    root: join(base, ".diligent"),
    sessions: join(base, ".diligent", "sessions"),
    knowledge: join(base, ".diligent", "knowledge"),
    skills: join(base, ".diligent", "skills"),
    images: join(base, ".diligent", "images"),
  };
}

afterEach(async () => {
  if (originalStorageNamespace !== undefined) {
    process.env.DILIGENT_STORAGE_NAMESPACE = originalStorageNamespace;
  } else {
    delete process.env.DILIGENT_STORAGE_NAMESPACE;
  }
  originalStorageNamespace = undefined;
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

describe("loadRuntimeConfig", () => {
  it("loads discovered agents and adds an agents section to the system prompt", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-config-"));
    const paths = makePaths(tmpRoot);
    const isolatedHome = join(tmpRoot, ".isolated-home");
    await mkdir(paths.sessions, { recursive: true });
    await mkdir(paths.knowledge, { recursive: true });
    await mkdir(paths.skills, { recursive: true });
    await mkdir(paths.images, { recursive: true });
    await mkdir(join(isolatedHome, ".diligent"), { recursive: true });
    const agentDir = join(tmpRoot, ".diligent", "agents", "code-reviewer");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "AGENT.md"),
      [
        "---",
        "name: code-reviewer",
        "description: Reviews code carefully",
        "tools: read, glob",
        "model_class: general",
        "---",
        "You are a code reviewer.",
      ].join("\n"),
    );
    await writeFile(join(tmpRoot, ".diligent", "config.jsonc"), JSON.stringify({ model: "claude-sonnet-4-6" }));

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    let config: RuntimeConfig;
    try {
      config = await loadRuntimeConfig(tmpRoot, paths);
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
    }

    expect(config.agents).toHaveLength(1);
    expect(config.agents[0]?.name).toBe("code-reviewer");
    expect(config.agentDefinitions.some((agent) => agent.name === "general" && agent.source === "builtin")).toBe(true);
    expect(config.agentDefinitions.some((agent) => agent.name === "code-reviewer" && agent.source === "user")).toBe(
      true,
    );
    expect(
      config.systemPrompt.some((section) => section.label === "agents" && section.content.includes("code-reviewer")),
    ).toBe(true);
  });

  it("generates and persists a fallback userId when config userId is unset", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-userid-"));
    const paths = makePaths(tmpRoot);
    const isolatedHome = join(tmpRoot, ".isolated-home");
    await mkdir(paths.sessions, { recursive: true });
    await mkdir(paths.knowledge, { recursive: true });
    await mkdir(paths.skills, { recursive: true });
    await mkdir(paths.images, { recursive: true });
    await mkdir(join(isolatedHome, ".diligent"), { recursive: true });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    try {
      const first = await loadRuntimeConfig(tmpRoot, paths);
      const second = await loadRuntimeConfig(tmpRoot, paths);
      const stored = (await readFile(join(isolatedHome, ".diligent", "user-id"), "utf8")).trim();

      expect(first.diligent.userId).toBeDefined();
      expect(first.diligent.userId).toBe(second.diligent.userId);
      expect(first.diligent.userId).toBe(stored);
      expect(stored).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("prefers explicit config userId over the persisted fallback", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-explicit-userid-"));
    const paths = makePaths(tmpRoot);
    const isolatedHome = join(tmpRoot, ".isolated-home");
    await mkdir(paths.sessions, { recursive: true });
    await mkdir(paths.knowledge, { recursive: true });
    await mkdir(paths.skills, { recursive: true });
    await mkdir(paths.images, { recursive: true });
    await mkdir(join(isolatedHome, ".diligent"), { recursive: true });
    await writeFile(join(tmpRoot, ".diligent", "config.jsonc"), JSON.stringify({ userId: "explicit-user" }));

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    try {
      const config = await loadRuntimeConfig(tmpRoot, paths);
      const fallbackPath = join(isolatedHome, ".diligent", "user-id");

      expect(config.diligent.userId).toBe("explicit-user");
      expect(await Bun.file(fallbackPath).exists()).toBe(false);
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("uses the selected namespace for user-id persistence and project config", async () => {
    originalStorageNamespace = process.env.DILIGENT_STORAGE_NAMESPACE;
    process.env.DILIGENT_STORAGE_NAMESPACE = "overdare";
    tmpRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-branded-"));
    const brandedPaths: DiligentPaths = {
      root: join(tmpRoot, ".overdare"),
      sessions: join(tmpRoot, ".overdare", "sessions"),
      knowledge: join(tmpRoot, ".overdare", "knowledge"),
      skills: join(tmpRoot, ".overdare", "skills"),
      images: join(tmpRoot, ".overdare", "images"),
    };
    const isolatedHome = join(tmpRoot, ".isolated-home");
    await mkdir(brandedPaths.sessions, { recursive: true });
    await mkdir(brandedPaths.knowledge, { recursive: true });
    await mkdir(brandedPaths.skills, { recursive: true });
    await mkdir(brandedPaths.images, { recursive: true });
    await mkdir(join(isolatedHome, ".overdare"), { recursive: true });
    await writeFile(join(tmpRoot, ".overdare", "config.jsonc"), JSON.stringify({ userId: "overdare-user" }));

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    try {
      const config = await loadRuntimeConfig(tmpRoot, brandedPaths);
      expect(config.diligent.userId).toBe("overdare-user");
      expect(config.authStore.mode).toBe("auto");
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("binds vertex config and selects the first available vertex model", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-vertex-"));
    const paths = makePaths(tmpRoot);
    const isolatedHome = join(tmpRoot, ".isolated-home");
    await mkdir(paths.sessions, { recursive: true });
    await mkdir(paths.knowledge, { recursive: true });
    await mkdir(paths.skills, { recursive: true });
    await mkdir(paths.images, { recursive: true });
    await mkdir(join(isolatedHome, ".diligent"), { recursive: true });
    await writeFile(
      join(tmpRoot, ".diligent", "config.jsonc"),
      JSON.stringify({
        provider: {
          vertex: {
            project: "demo-project",
            location: "us-central1",
            endpoint: "openapi",
            authMode: "access_token",
            accessToken: "ya29.test-token",
          },
        },
      }),
    );

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    try {
      const config = await loadRuntimeConfig(tmpRoot, paths);
      expect(config.providerManager.hasKeyFor("vertex")).toBe(true);
      expect(config.providerManager.getMaskedKey("vertex")).toBe("Vertex access token");
      expect(config.model?.provider).toBe("vertex");
      expect(config.model?.id).toBe("vertex-gemma-4-26b-it");
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("loads zai-coding-plan auth from auth.jsonc and selects glm-5.2 when no model is configured", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-zai-coding-plan-"));
    const paths = makePaths(tmpRoot);
    const isolatedHome = join(tmpRoot, ".isolated-home");
    await mkdir(paths.sessions, { recursive: true });
    await mkdir(paths.knowledge, { recursive: true });
    await mkdir(paths.skills, { recursive: true });
    await mkdir(paths.images, { recursive: true });
    await mkdir(join(isolatedHome, ".diligent"), { recursive: true });
    await writeFile(
      join(isolatedHome, ".diligent", "auth.jsonc"),
      JSON.stringify({ "zai-coding-plan": "zai-test-key" }),
    );
    await writeFile(
      join(tmpRoot, ".diligent", "config.jsonc"),
      JSON.stringify({ provider: { "zai-coding-plan": {} } }),
    );

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    try {
      const config = await loadRuntimeConfig(tmpRoot, paths);
      expect(config.providerManager.hasKeyFor("zai-coding-plan")).toBe(true);
      expect(config.providerManager.getMaskedKey("zai-coding-plan")).toBe("zai-tes...");
      expect(config.model?.provider).toBe("zai-coding-plan");
      expect(config.model?.id).toBe("glm-5.2");
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("reads auth credential store mode from config", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-auth-store-"));
    const paths = makePaths(tmpRoot);
    const isolatedHome = join(tmpRoot, ".isolated-home");
    await mkdir(paths.sessions, { recursive: true });
    await mkdir(paths.knowledge, { recursive: true });
    await mkdir(paths.skills, { recursive: true });
    await mkdir(paths.images, { recursive: true });
    await mkdir(join(isolatedHome, ".diligent"), { recursive: true });
    await writeFile(
      join(tmpRoot, ".diligent", "config.jsonc"),
      JSON.stringify({ provider: { auth: { credentialsStore: "keyring" } } }),
    );

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    try {
      const config = await loadRuntimeConfig(tmpRoot, paths);
      expect(config.authStore.mode).toBe("keyring");
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("does not fail startup when stored ChatGPT OAuth refresh fails and removes stale tokens", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-chatgpt-refresh-fail-"));
    const paths = makePaths(tmpRoot);
    const isolatedHome = join(tmpRoot, ".isolated-home");
    await mkdir(paths.sessions, { recursive: true });
    await mkdir(paths.knowledge, { recursive: true });
    await mkdir(paths.skills, { recursive: true });
    await mkdir(paths.images, { recursive: true });
    await mkdir(join(isolatedHome, ".diligent"), { recursive: true });
    await writeFile(
      join(tmpRoot, ".diligent", "config.jsonc"),
      JSON.stringify({ provider: { auth: { credentialsStore: "file" } } }),
    );
    await writeFile(
      join(isolatedHome, ".diligent", "auth.jsonc"),
      JSON.stringify({
        chatgpt_oauth: {
          access_token: "expired-access-token",
          refresh_token: "reused-refresh-token",
          id_token: "expired-id-token",
          expires_at: Date.now() - 60_000,
        },
      }),
    );

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalFetch = globalThis.fetch;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "Your refresh token has already been used to generate a new access token. Please try signing in again.",
              type: "invalid_request_error",
              code: "refresh_token_reused",
            },
          }),
          { status: 401 },
        ),
    ) as unknown as typeof fetch;

    try {
      const config = await loadRuntimeConfig(tmpRoot, paths);
      const authFile = join(isolatedHome, ".diligent", "auth.jsonc");

      expect(config.providerManager.hasKeyFor("chatgpt")).toBe(false);
      expect(await Bun.file(authFile).exists()).toBe(false);
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      globalThis.fetch = originalFetch;
    }
  });
});
