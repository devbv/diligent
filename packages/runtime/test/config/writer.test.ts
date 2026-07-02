// @summary Tests for project tool config writer — JSONC-preserving tools subtree patching and normalization

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_ANTHROPIC_MODEL_ID } from "@diligent/core/llm/models";

import {
  applyToolConfigPatch,
  getGlobalConfigPath,
  getProjectConfigPath,
  normalizeStoredToolsConfig,
  saveGlobalAutoProgressMode,
  saveGlobalConsent,
  writeGlobalToolsConfig,
  writeProjectToolsConfig,
} from "../../src/config/writer";

const TMP_PREFIX = join(process.cwd(), ".tmp-p032-writer-");
const tempDirs: string[] = [];

async function makeTempProject(): Promise<string> {
  const dir = await mkdtemp(TMP_PREFIX);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("normalizeStoredToolsConfig", () => {
  it("stores only user-intent false overrides and non-default conflict policy", () => {
    expect(
      normalizeStoredToolsConfig({
        web_action: false,
        builtin: { bash: false, read: true },
        plugins: [
          {
            package: "@acme/diligent-tools",
            enabled: true,
            tools: { jira_comment: false, jira_open: true },
          },
        ],
        conflictPolicy: "error",
      }),
    ).toEqual({
      web_action: false,
      builtin: { bash: false },
      plugins: [
        {
          package: "@acme/diligent-tools",
          tools: { jira_comment: false },
        },
      ],
    });
  });

  it("keeps plugin package entries when the user intends the package to stay configured", () => {
    expect(
      normalizeStoredToolsConfig({
        builtin: { bash: true },
        plugins: [{ package: "@acme/diligent-tools", enabled: true, tools: { jira_comment: true } }],
        conflictPolicy: "error",
      }),
    ).toEqual({
      plugins: [{ package: "@acme/diligent-tools" }],
    });
  });

  it("stores web only when the user disables it", () => {
    expect(normalizeStoredToolsConfig({ web_action: false, builtin: { bash: true }, conflictPolicy: "error" })).toEqual(
      {
        web_action: false,
      },
    );
    expect(
      normalizeStoredToolsConfig({ web_action: true, builtin: { bash: true }, conflictPolicy: "error" }),
    ).toBeUndefined();
  });
});

describe("applyToolConfigPatch", () => {
  it("merges builtin and plugin patches and supports remove", () => {
    expect(
      applyToolConfigPatch(
        {
          web_action: false,
          builtin: { bash: false },
          plugins: [
            {
              package: "@acme/one",
              enabled: false,
              tools: { jira_comment: false },
            },
            {
              package: "@acme/two",
              enabled: true,
              tools: { alpha: false },
            },
          ],
          conflictPolicy: "builtin_wins",
        },
        {
          web_action: true,
          builtin: { read: false, bash: true },
          plugins: [
            { package: "@acme/one", enabled: true, tools: { jira_comment: true, jira_open: false } },
            { package: "@acme/two", remove: true },
            { package: "@acme/three", enabled: false, tools: { beta: false } },
          ],
          conflictPolicy: "error",
        },
      ),
    ).toEqual({
      builtin: { read: false },
      plugins: [
        {
          package: "@acme/one",
          tools: { jira_open: false },
        },
        {
          package: "@acme/three",
          enabled: false,
          tools: { beta: false },
        },
      ],
    });
  });
});

describe("writeProjectToolsConfig", () => {
  it("creates .diligent/config.jsonc when missing", async () => {
    const cwd = await makeTempProject();

    const result = await writeProjectToolsConfig(cwd, {
      web_action: false,
      builtin: { bash: false },
      plugins: [{ package: "@acme/diligent-tools", tools: { jira_comment: false } }],
    });

    const configPath = getProjectConfigPath(cwd);
    const text = await Bun.file(configPath).text();

    expect(result.configPath).toBe(configPath);
    expect(text).toContain('"tools"');
    expect(text).toContain('"web_action": false');
    expect(text).toContain('"bash": false');
    expect(text).toContain('"package": "@acme/diligent-tools"');
    expect(result.tools).toEqual({
      web_action: false,
      builtin: { bash: false },
      plugins: [{ package: "@acme/diligent-tools", tools: { jira_comment: false } }],
    });
  });

  it("patches only the tools subtree and preserves unrelated sections/comments where possible", async () => {
    const cwd = await makeTempProject();
    const configPath = getProjectConfigPath(cwd);
    await Bun.write(
      configPath,
      `{
  // keep provider comment
  "provider": {
    "openai": {
      "apiKey": "secret"
    }
  },
  "tools": {
    "builtin": {
      "bash": false
    }
  }
}
`,
    );

    await writeProjectToolsConfig(cwd, {
      web_action: false,
      builtin: { read: false },
      plugins: [{ package: "@acme/diligent-tools", enabled: false, tools: { jira_comment: false } }],
      conflictPolicy: "plugin_wins",
    });

    const text = await Bun.file(configPath).text();
    expect(text).toContain("// keep provider comment");
    expect(text).toContain('"provider"');
    expect(text).toContain('"apiKey": "secret"');
    expect(text).toContain('"web_action": false');
    expect(text).toContain('"bash": false');
    expect(text).toContain('"read": false');
    expect(text).toContain('"conflictPolicy": "plugin_wins"');
    expect(text).toContain('"enabled": false');
  });

  it("supports plugin removal", async () => {
    const cwd = await makeTempProject();
    const configPath = getProjectConfigPath(cwd);
    await Bun.write(
      configPath,
      `{
  "tools": {
    "plugins": [
      { "package": "@acme/one", "enabled": false, "tools": { "jira_comment": false } },
      { "package": "@acme/two", "tools": { "alpha": false } }
    ]
  }
}
`,
    );

    const result = await writeProjectToolsConfig(cwd, {
      plugins: [{ package: "@acme/one", remove: true }],
    });

    const text = await Bun.file(configPath).text();
    expect(text).not.toContain("@acme/one");
    expect(text).toContain("@acme/two");
    expect(result.tools).toEqual({
      plugins: [{ package: "@acme/two", tools: { alpha: false } }],
    });
  });

  it("removes the tools subtree entirely when normalized config becomes empty", async () => {
    const cwd = await makeTempProject();
    const configPath = getProjectConfigPath(cwd);
    await Bun.write(
      configPath,
      `{
  "model": "gpt-4o",
  "tools": {
    "builtin": {
      "bash": false
    }
  }
}
`,
    );

    const result = await writeProjectToolsConfig(cwd, {
      builtin: { bash: true },
    });

    const text = await Bun.file(configPath).text();
    expect(text).toContain('"model": "gpt-4o"');
    expect(text).not.toContain('"tools"');
    expect(result.tools).toBeUndefined();
  });

  it("returns validated config after write", async () => {
    const cwd = await makeTempProject();

    const result = await writeProjectToolsConfig(cwd, {
      web_action: false,
      builtin: { bash: false },
      conflictPolicy: "builtin_wins",
    });

    expect(result.config.model).toBeUndefined();
    expect(result.config.tools).toEqual({
      web_action: false,
      builtin: { bash: false },
      conflictPolicy: "builtin_wins",
    });
  });
});

describe("writeGlobalToolsConfig", () => {
  it("writes tools config to ~/.diligent/config.jsonc", async () => {
    const cwd = await makeTempProject();
    const originalHome = process.env.HOME;
    process.env.HOME = cwd;

    try {
      const result = await writeGlobalToolsConfig({
        web_action: false,
        plugins: [{ package: "@acme/diligent-tools", tools: { jira_comment: false } }],
      });

      const configPath = getGlobalConfigPath();
      const text = await Bun.file(configPath).text();
      expect(result.configPath).toBe(configPath);
      expect(text).toContain('"tools"');
      expect(text).toContain('"web_action": false');
      expect(text).toContain('"package": "@acme/diligent-tools"');
      expect(text).toContain('"jira_comment": false');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });
});

describe("saveGlobalConsent", () => {
  it("writes the consent subtree to ~/.diligent/config.jsonc and preserves existing keys/comments", async () => {
    const cwd = await makeTempProject();
    const originalHome = process.env.HOME;
    process.env.HOME = cwd;

    try {
      const configPath = getGlobalConfigPath();
      await Bun.write(configPath, `{\n  // keep me\n  "model": "${DEFAULT_ANTHROPIC_MODEL_ID}"\n}\n`);

      await saveGlobalConsent({
        noticeAcknowledgedVersion: "2026-06",
        serviceImprovement: false,
        updatedAt: "2026-06-23T00:00:00.000Z",
      });

      const text = await Bun.file(configPath).text();
      expect(text).toContain("// keep me");
      expect(text).toContain(`"model": "${DEFAULT_ANTHROPIC_MODEL_ID}"`);
      expect(text).toContain('"consent"');
      expect(text).toContain('"serviceImprovement": false');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });
});

describe("saveGlobalAutoProgressMode", () => {
  it("writes the account-scoped auto progress toggle to ~/.diligent/config.jsonc and preserves existing keys/comments", async () => {
    const cwd = await makeTempProject();
    const originalHome = process.env.HOME;
    process.env.HOME = cwd;

    try {
      const configPath = getGlobalConfigPath();
      await Bun.write(configPath, `{\n  // keep me\n  "model": "${DEFAULT_ANTHROPIC_MODEL_ID}"\n}\n`);

      await saveGlobalAutoProgressMode(true, "test-account");

      const text = await Bun.file(configPath).text();
      expect(text).toContain("// keep me");
      expect(text).toContain(`"model": "${DEFAULT_ANTHROPIC_MODEL_ID}"`);
      expect(text).toContain('"accounts"');
      expect(text).toContain('"test-account"');
      expect(text).toContain('"autoProgressMode": true');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });
});
