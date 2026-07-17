// @summary Tests for project tool config writer — JSONC-preserving tools subtree patching and normalization

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_ANTHROPIC_MODEL_ID } from "@diligent/core/model-registry";

import {
  applyToolConfigPatch,
  getGlobalConfigPath,
  getProjectConfigPath,
  normalizeStoredAgentsConfig,
  normalizeStoredSkillsConfig,
  normalizeStoredToolsConfig,
  saveGlobalConsent,
  writeGlobalAgentsConfig,
  writeGlobalSkillsConfig,
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

describe("writeGlobalSkillsConfig", () => {
  it("stores sorted false-only skill overrides and removes true entries", async () => {
    expect(
      normalizeStoredSkillsConfig({
        enabled: true,
        paths: ["/team-skills"],
        overrides: { zeta: false, alpha: true, beta: false },
      }),
    ).toEqual({
      enabled: true,
      paths: ["/team-skills"],
      overrides: { beta: false, zeta: false },
    });
  });

  it("patches global skills overrides while preserving sibling and retained override comments", async () => {
    const home = await makeTempProject();
    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const configPath = getGlobalConfigPath();
      await Bun.write(
        configPath,
        `{
  // keep model
  "model": "gpt-4o",
  "skills": {
    // keep master switch
    "enabled": true,
    // keep configured path
    "paths": ["/shared/team-skills"],
    "overrides": {
      // keep alpha override
      "alpha": false,
      "beta": false
    }
  }
}
`,
      );

      const result = await writeGlobalSkillsConfig({ overrides: { beta: true, zeta: false } });
      const text = await Bun.file(configPath).text();

      expect(text).toContain("// keep model");
      expect(text).toContain("// keep master switch");
      expect(text).toContain("// keep configured path");
      expect(text).toContain("// keep alpha override");
      expect(text).toContain('"model": "gpt-4o"');
      expect(text).toContain('"enabled": true');
      expect(text).toContain('"paths"');
      expect(text).toContain('"alpha": false');
      expect(text).toContain('"zeta": false');
      expect(text).not.toContain('"beta"');
      expect(result.skills).toEqual({
        enabled: true,
        paths: ["/shared/team-skills"],
        overrides: { alpha: false, zeta: false },
      });
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });

  it("removes an empty overrides property while keeping skills enabled and paths", async () => {
    const home = await makeTempProject();
    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const configPath = getGlobalConfigPath();
      await Bun.write(
        configPath,
        `{ "skills": { "enabled": false, "paths": ["/x"], "overrides": { "alpha": false } } }`,
      );

      const first = await writeGlobalSkillsConfig({ overrides: { alpha: true } });
      const second = await writeGlobalSkillsConfig({ overrides: { alpha: true } });
      const text = await Bun.file(configPath).text();

      expect(text).toContain('"enabled": false');
      expect(text).toContain('"paths"');
      expect(text).not.toContain('"overrides"');
      expect(first.skills).toEqual({ enabled: false, paths: ["/x"] });
      expect(second.skills).toEqual({ enabled: false, paths: ["/x"] });
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });

  it("does not modify an invalid global config", async () => {
    const home = await makeTempProject();
    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const configPath = getGlobalConfigPath();
      const original = `{
  "model": 42
}\n`;
      await Bun.write(configPath, original);

      await expect(writeGlobalSkillsConfig({ overrides: { "tech-lead": false } })).rejects.toThrow(
        "Failed to validate existing config",
      );
      expect(await Bun.file(configPath).text()).toBe(original);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });
});

describe("writeGlobalAgentsConfig", () => {
  it("stores sorted false-only optional overrides while preserving sibling agent settings and comments", async () => {
    const home = await makeTempProject();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const configPath = getGlobalConfigPath();
      await Bun.write(
        configPath,
        `{
  "agents": {
    // preserve discovery gate
    "enabled": true,
    "paths": ["/team-agents"],
    "overrides": {
      // retain reviewer preference
      "reviewer": false,
      "explore": false
    }
  }
}
`,
      );
      const result = await writeGlobalAgentsConfig({ overrides: { explore: true, auditor: false } });
      const text = await Bun.file(configPath).text();
      expect(text).toContain("// preserve discovery gate");
      expect(text).toContain("// retain reviewer preference");
      expect(text).toContain('"enabled": true');
      expect(text).toContain('"paths"');
      expect(text).toContain('"reviewer": false');
      expect(text).toContain('"auditor": false');
      expect(text).not.toContain('"explore"');
      expect(result.agents).toEqual({
        enabled: true,
        paths: ["/team-agents"],
        overrides: { auditor: false, reviewer: false },
      });
      expect(normalizeStoredAgentsConfig({ overrides: { zeta: false, alpha: true } })).toEqual({
        overrides: { zeta: false },
      });
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });

  it("does not modify an invalid global config", async () => {
    const home = await makeTempProject();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const configPath = getGlobalConfigPath();
      const original = `{ "agents": { "overrides": { "explore": "off" } } }\n`;
      await Bun.write(configPath, original);
      await expect(writeGlobalAgentsConfig({ overrides: { explore: false } })).rejects.toThrow(
        "Failed to validate existing config",
      );
      expect(await Bun.file(configPath).text()).toBe(original);
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
