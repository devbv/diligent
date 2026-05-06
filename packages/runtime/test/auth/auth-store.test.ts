// @summary Tests for runtime auth-store file, keyring, auto-fallback, and ephemeral behavior
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenAIOAuthTokens } from "@diligent/core/auth";
import {
  __resetEphemeralAuthStoreForTests,
  __setKeytarForTests,
  getAuthFilePath,
  getAuthKeyringAccount,
  getAuthKeyringServiceName,
  loadAuthStore,
  loadOAuthTokens,
  removeAuthKey,
  removeOAuthTokens,
  saveAuthKey,
  saveOAuthTokens,
} from "../../src/auth/auth-store";

const TEST_ROOT = join(tmpdir(), `diligent-auth-test-${Date.now()}`);
let origHome: string | undefined;
let origUserProfile: string | undefined;
let origStorageNamespace: string | undefined;

const TEST_OAUTH_TOKENS: OpenAIOAuthTokens = {
  access_token: "at-test",
  refresh_token: "rt-test",
  id_token: "it-test",
  expires_at: 9_999_999_999_000,
  account_id: "acc-test",
};

function authOptions(path: string, mode: "file" | "keyring" | "auto" | "ephemeral") {
  return { path, mode } as const;
}

function createFakeKeytar(initial?: Record<string, string>, behavior?: { failLoad?: boolean; failSave?: boolean }) {
  const store = new Map(Object.entries(initial ?? {}));
  return {
    store,
    adapter: {
      async getPassword(service: string, account: string): Promise<string | null> {
        if (behavior?.failLoad) throw new Error("keyring load failed");
        return store.get(`${service}:${account}`) ?? null;
      },
      async setPassword(service: string, account: string, password: string): Promise<void> {
        if (behavior?.failSave) throw new Error("keyring save failed");
        store.set(`${service}:${account}`, password);
      },
      async deletePassword(service: string, account: string): Promise<boolean> {
        return store.delete(`${service}:${account}`);
      },
    },
  };
}

beforeEach(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  origStorageNamespace = process.env.DILIGENT_STORAGE_NAMESPACE;
  process.env.HOME = TEST_ROOT;
  process.env.USERPROFILE = TEST_ROOT;
  delete process.env.DILIGENT_STORAGE_NAMESPACE;
  __setKeytarForTests(null);
  __resetEphemeralAuthStoreForTests();
});

afterEach(async () => {
  __setKeytarForTests(null);
  __resetEphemeralAuthStoreForTests();
  if (origHome !== undefined) {
    process.env.HOME = origHome;
  } else {
    delete process.env.HOME;
  }
  if (origUserProfile !== undefined) {
    process.env.USERPROFILE = origUserProfile;
  } else {
    delete process.env.USERPROFILE;
  }
  if (origStorageNamespace !== undefined) {
    process.env.DILIGENT_STORAGE_NAMESPACE = origStorageNamespace;
  } else {
    delete process.env.DILIGENT_STORAGE_NAMESPACE;
  }
  try {
    await rm(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

describe("getAuthFilePath", () => {
  test("returns path under ~/.diligent/", () => {
    const path = getAuthFilePath();
    expect(path).toContain("diligent");
    expect(path).toEndWith("auth.jsonc");
  });

  test("uses the selected storage namespace", () => {
    process.env.DILIGENT_STORAGE_NAMESPACE = "overdare";
    expect(getAuthFilePath()).toBe(join(TEST_ROOT, ".overdare", "auth.jsonc"));
  });
});

describe("keyring metadata", () => {
  test("uses a stable service and account id", () => {
    const path = join(TEST_ROOT, ".diligent", "auth.jsonc");
    expect(getAuthKeyringServiceName()).toBe("Diligent Auth");
    expect(getAuthKeyringAccount(path)).toMatch(/^cli\|[0-9a-f]{16}$/);
    expect(getAuthKeyringAccount(path)).toBe(getAuthKeyringAccount(path));
  });
});

describe("file storage", () => {
  test("returns {} when file does not exist", async () => {
    const result = await loadAuthStore(authOptions(join(TEST_ROOT, "nonexistent.jsonc"), "file"));
    expect(result).toEqual({});
  });

  test("loads valid auth keys", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    await Bun.write(path, JSON.stringify({ anthropic: "sk-ant-123", openai: "sk-456", zai: "zai-789" }));

    const result = await loadAuthStore(authOptions(path, "file"));
    expect(result.anthropic).toBe("sk-ant-123");
    expect(result.openai).toBe("sk-456");
    expect(result.zai).toBe("zai-789");
  });

  test("parses JSONC comments", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    await Bun.write(path, '{\n  // primary provider\n  "anthropic": "sk-ant-123"\n}\n');

    const result = await loadAuthStore(authOptions(path, "file"));
    expect(result.anthropic).toBe("sk-ant-123");
  });

  test("substitutes {env:VAR} in values", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    process.env.TEST_ANTHROPIC_KEY = "sk-from-env";
    await Bun.write(path, JSON.stringify({ anthropic: "{env:TEST_ANTHROPIC_KEY}" }));

    const result = await loadAuthStore(authOptions(path, "file"));
    expect(result.anthropic).toBe("sk-from-env");
    delete process.env.TEST_ANTHROPIC_KEY;
  });

  test("saves and preserves mixed credentials", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    await saveAuthKey("anthropic", "sk-ant", authOptions(path, "file"));
    await saveOAuthTokens(TEST_OAUTH_TOKENS, authOptions(path, "file"));

    const content = JSON.parse(await Bun.file(path).text());
    expect(content.anthropic).toBe("sk-ant");
    expect(content.chatgpt_oauth).toEqual(TEST_OAUTH_TOKENS);
  });

  test.skipIf(process.platform === "win32")("sets file permissions to 0o600", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    await saveAuthKey("gemini", "AIza-test", authOptions(path, "file"));
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("removes oauth without disturbing API keys", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    await Bun.write(path, JSON.stringify({ anthropic: "sk-ant", chatgpt_oauth: TEST_OAUTH_TOKENS }));

    await removeOAuthTokens(authOptions(path, "file"));

    const content = JSON.parse(await Bun.file(path).text());
    expect(content.anthropic).toBe("sk-ant");
    expect(content.chatgpt_oauth).toBeUndefined();
  });
});

describe("keyring storage", () => {
  test("loads credentials from keyring", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    const service = getAuthKeyringServiceName();
    const account = getAuthKeyringAccount(path);
    const fake = createFakeKeytar({ [`${service}:${account}`]: JSON.stringify({ anthropic: "sk-keyring" }) });
    __setKeytarForTests(fake.adapter);

    const result = await loadAuthStore(authOptions(path, "keyring"));
    expect(result.anthropic).toBe("sk-keyring");
  });

  test("load returns empty when keyring backend is unavailable", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");

    await expect(loadAuthStore(authOptions(path, "keyring"))).resolves.toEqual({});
  });

  test("saving to keyring removes fallback file", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    await Bun.write(path, JSON.stringify({ anthropic: "old-file-key" }));
    const fake = createFakeKeytar();
    __setKeytarForTests(fake.adapter);

    await saveAuthKey("anthropic", "sk-keyring", authOptions(path, "keyring"));

    const exists = await Bun.file(path).exists();
    expect(exists).toBe(false);
    const saved = fake.store.get(`${getAuthKeyringServiceName()}:${getAuthKeyringAccount(path)}`);
    expect(saved).toBeDefined();
    expect(JSON.parse(saved ?? "{}").anthropic).toBe("sk-keyring");
  });
});

describe("auto storage fallback", () => {
  test("prefers keyring over file when both exist", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    await Bun.write(path, JSON.stringify({ anthropic: "file-key" }));
    const service = getAuthKeyringServiceName();
    const account = getAuthKeyringAccount(path);
    const fake = createFakeKeytar({ [`${service}:${account}`]: JSON.stringify({ anthropic: "keyring-key" }) });
    __setKeytarForTests(fake.adapter);

    const result = await loadAuthStore(authOptions(path, "auto"));
    expect(result.anthropic).toBe("keyring-key");
  });

  test("falls back to file when keyring is empty", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    await Bun.write(path, JSON.stringify({ anthropic: "file-key" }));
    const fake = createFakeKeytar();
    __setKeytarForTests(fake.adapter);

    const result = await loadAuthStore(authOptions(path, "auto"));
    expect(result.anthropic).toBe("file-key");
  });

  test("falls back to file when keyring load fails", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    await Bun.write(path, JSON.stringify({ anthropic: "file-key" }));
    const fake = createFakeKeytar(undefined, { failLoad: true });
    __setKeytarForTests(fake.adapter);

    const result = await loadAuthStore(authOptions(path, "auto"));
    expect(result.anthropic).toBe("file-key");
  });

  test("falls back to file when keyring save fails", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    const fake = createFakeKeytar(undefined, { failSave: true });
    __setKeytarForTests(fake.adapter);

    await saveAuthKey("anthropic", "file-fallback-key", authOptions(path, "auto"));

    const content = JSON.parse(await Bun.file(path).text());
    expect(content.anthropic).toBe("file-fallback-key");
  });
});

describe("ephemeral storage", () => {
  test("stores credentials only in memory", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");

    await saveAuthKey("anthropic", "mem-key", authOptions(path, "ephemeral"));
    await saveOAuthTokens(TEST_OAUTH_TOKENS, authOptions(path, "ephemeral"));

    const loaded = await loadAuthStore(authOptions(path, "ephemeral"));
    expect(loaded.anthropic).toBe("mem-key");
    expect(loaded.chatgpt_oauth).toEqual(TEST_OAUTH_TOKENS);
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("delete clears the in-memory entry", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    await saveAuthKey("anthropic", "mem-key", authOptions(path, "ephemeral"));

    await removeAuthKey("anthropic", authOptions(path, "ephemeral"));

    const loaded = await loadAuthStore(authOptions(path, "ephemeral"));
    expect(loaded).toEqual({});
  });
});

describe("loadOAuthTokens", () => {
  test("returns undefined when file does not exist", async () => {
    const result = await loadOAuthTokens(authOptions(join(TEST_ROOT, "missing.jsonc"), "file"));
    expect(result).toBeUndefined();
  });

  test("returns OAuth tokens when present in auto-backed keyring", async () => {
    const path = join(TEST_ROOT, "auth.jsonc");
    const service = getAuthKeyringServiceName();
    const account = getAuthKeyringAccount(path);
    const fake = createFakeKeytar({ [`${service}:${account}`]: JSON.stringify({ chatgpt_oauth: TEST_OAUTH_TOKENS }) });
    __setKeytarForTests(fake.adapter);

    const result = await loadOAuthTokens(authOptions(path, "auto"));
    expect(result).toEqual(TEST_OAUTH_TOKENS);
  });
});
