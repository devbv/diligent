// @summary Loads and saves API keys and OAuth tokens from file or OS keyring with fallback behavior
import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { OpenAIOAuthTokens } from "@diligent/core/auth";
import type { ProviderName } from "@diligent/core/llm/types";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import { resolveProjectDirName } from "../infrastructure/diligent-dir";

export type AuthKeys = {
  anthropic?: string;
  openai?: string;
  chatgpt?: string;
  gemini?: string;
  vertex?: string;
  zai?: string;
  chatgpt_oauth?: OpenAIOAuthTokens;
};

export type AuthCredentialsStoreMode = "file" | "keyring" | "auto" | "ephemeral";

export interface AuthStoreOptions {
  path?: string;
  mode?: AuthCredentialsStoreMode;
}

interface KeyringAdapter {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

interface AuthStorageBackend {
  load(): Promise<AuthKeys>;
  save(store: AuthKeys): Promise<void>;
  delete(): Promise<boolean>;
}

type KeyringStorageFactory = () => Promise<KeyringAuthStorage>;

const KEYRING_SERVICE = "Diligent Auth";
const KEYRING_ACCOUNT_PREFIX = "cli|";
const DEFAULT_AUTH_CREDENTIALS_STORE_MODE: AuthCredentialsStoreMode = "auto";
const ephemeralStore = new Map<string, AuthKeys>();

let keytarOverride: KeyringAdapter | null = null;
let keytarPromise: Promise<KeyringAdapter> | null = null;

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

const OpenAIOAuthSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  id_token: z.string(),
  expires_at: z.number(),
  account_id: z.string().optional(),
});

const AuthKeysSchema = z
  .object({
    anthropic: z.string().optional(),
    openai: z.string().optional(),
    chatgpt: z.string().optional(),
    gemini: z.string().optional(),
    vertex: z.string().optional(),
    zai: z.string().optional(),
    chatgpt_oauth: OpenAIOAuthSchema.optional(),
  })
  .strict();

function normalizeOptions(options?: string | AuthStoreOptions): Required<AuthStoreOptions> {
  if (typeof options === "string") {
    return { path: options, mode: DEFAULT_AUTH_CREDENTIALS_STORE_MODE };
  }
  return {
    path: options?.path ?? getAuthFilePath(),
    mode: options?.mode ?? DEFAULT_AUTH_CREDENTIALS_STORE_MODE,
  };
}

export function getAuthFilePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(home, resolveProjectDirName(), "auth.jsonc");
}

export function getAuthStorageRootPath(): string {
  return dirname(getAuthFilePath());
}

export function getAuthKeyringServiceName(): string {
  return KEYRING_SERVICE;
}

export function getAuthKeyringAccount(path?: string): string {
  const rootPath = dirname(path ?? getAuthFilePath());
  const resolved = resolve(rootPath);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return `${KEYRING_ACCOUNT_PREFIX}${hash}`;
}

function substituteEnv(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] =
      typeof value === "string" ? value.replace(/\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? "") : value;
  }
  return result;
}

async function readValidatedStore(filePath: string, warnOnInvalid: boolean): Promise<AuthKeys> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return {};
    const text = await file.text();
    const parsed = parseJsonc(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result = AuthKeysSchema.safeParse(substituteEnv(parsed as Record<string, unknown>));
    if (!result.success) {
      if (warnOnInvalid) {
        console.warn(`auth.jsonc warning: ${filePath}\n${result.error.message}`);
      }
      return {};
    }
    return result.data;
  } catch {
    return {};
  }
}

async function loadFileStore(filePath: string, warnOnInvalid: boolean): Promise<AuthKeys> {
  return readValidatedStore(filePath, warnOnInvalid);
}

async function writeStore(filePath: string, store: AuthKeys): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, `${JSON.stringify(store, null, 2)}\n`);
  await chmod(filePath, 0o600);
}

async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    if (!(await Bun.file(filePath).exists())) return false;
    await rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function loadKeytar(): Promise<KeyringAdapter> {
  if (keytarOverride) return keytarOverride;
  keytarPromise ??= import("keytar").then((module) => {
    const keytar = (module.default ?? module) as unknown as KeytarLike;
    return {
      getPassword: keytar.getPassword.bind(keytar),
      setPassword: keytar.setPassword.bind(keytar),
      deletePassword: keytar.deletePassword.bind(keytar),
    } satisfies KeyringAdapter;
  });
  return keytarPromise;
}

class FileAuthStorage implements AuthStorageBackend {
  constructor(private readonly filePath: string) {}

  load(): Promise<AuthKeys> {
    return loadFileStore(this.filePath, true);
  }

  async save(store: AuthKeys): Promise<void> {
    await writeStore(this.filePath, store);
  }

  delete(): Promise<boolean> {
    return removeFileIfExists(this.filePath);
  }
}

class KeyringAuthStorage implements AuthStorageBackend {
  private readonly account: string;
  private readonly fileStorage: FileAuthStorage;

  constructor(
    readonly filePath: string,
    private readonly keyring: KeyringAdapter,
  ) {
    this.account = getAuthKeyringAccount(filePath);
    this.fileStorage = new FileAuthStorage(filePath);
  }

  async load(): Promise<AuthKeys> {
    const raw = await this.keyring.getPassword(KEYRING_SERVICE, this.account);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    const result = AuthKeysSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(`keyring auth warning: ${result.error.message}`);
      return {};
    }
    return result.data;
  }

  async save(store: AuthKeys): Promise<void> {
    await this.keyring.setPassword(KEYRING_SERVICE, this.account, JSON.stringify(store));
    await this.fileStorage.delete();
  }

  async delete(): Promise<boolean> {
    const deletedKeyring = await this.keyring.deletePassword(KEYRING_SERVICE, this.account);
    const deletedFile = await this.fileStorage.delete();
    return deletedKeyring || deletedFile;
  }
}

class LazyKeyringAuthStorage implements AuthStorageBackend {
  constructor(private readonly getStorage: KeyringStorageFactory) {}

  async load(): Promise<AuthKeys> {
    const storage = await this.getStorage();
    return storage.load();
  }

  async save(store: AuthKeys): Promise<void> {
    const storage = await this.getStorage();
    await storage.save(store);
  }

  async delete(): Promise<boolean> {
    const storage = await this.getStorage();
    return storage.delete();
  }
}

class AutoAuthStorage implements AuthStorageBackend {
  private readonly fileStorage: FileAuthStorage;

  constructor(
    filePath: string,
    private readonly getKeyringStorage: KeyringStorageFactory,
  ) {
    this.fileStorage = new FileAuthStorage(filePath);
  }

  async load(): Promise<AuthKeys> {
    try {
      const keyring = await this.getKeyringStorage();
      const fromKeyring = await keyring.load();
      if (Object.keys(fromKeyring).length > 0) return fromKeyring;
    } catch (error) {
      console.warn(
        `[auth] Keyring load failed, falling back to file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.fileStorage.load();
  }

  async save(store: AuthKeys): Promise<void> {
    try {
      const keyring = await this.getKeyringStorage();
      await keyring.save(store);
      return;
    } catch (error) {
      console.warn(
        `[auth] Keyring save failed, falling back to file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.fileStorage.save(store);
  }

  async delete(): Promise<boolean> {
    try {
      const keyring = await this.getKeyringStorage();
      return await keyring.delete();
    } catch {
      return this.fileStorage.delete();
    }
  }
}

class EphemeralAuthStorage implements AuthStorageBackend {
  private readonly key: string;

  constructor(filePath: string) {
    this.key = getAuthKeyringAccount(filePath);
  }

  async load(): Promise<AuthKeys> {
    return ephemeralStore.get(this.key) ?? {};
  }

  async save(store: AuthKeys): Promise<void> {
    ephemeralStore.set(this.key, structuredClone(store));
  }

  async delete(): Promise<boolean> {
    return ephemeralStore.delete(this.key);
  }
}

async function createAuthStorage(options?: string | AuthStoreOptions): Promise<AuthStorageBackend> {
  const normalized = normalizeOptions(options);
  const { path, mode } = normalized;
  const fileStorage = new FileAuthStorage(path);
  const createKeyringStorage: KeyringStorageFactory = async () => new KeyringAuthStorage(path, await loadKeytar());

  switch (mode) {
    case "file":
      return fileStorage;
    case "keyring":
      return new LazyKeyringAuthStorage(createKeyringStorage);
    case "auto":
      return new AutoAuthStorage(path, createKeyringStorage);
    case "ephemeral":
      return new EphemeralAuthStorage(path);
  }
}

async function loadStoreForUpdate(
  options?: string | AuthStoreOptions,
): Promise<{ backend: AuthStorageBackend; store: AuthKeys }> {
  const backend = await createAuthStorage(options);
  const store = await backend.load();
  return { backend, store };
}

export async function loadAuthStore(options?: string | AuthStoreOptions): Promise<AuthKeys> {
  const backend = await createAuthStorage(options);
  return backend.load();
}

export async function saveAuthKey(
  provider: ProviderName,
  apiKey: string,
  options?: string | AuthStoreOptions,
): Promise<void> {
  const { backend, store: existing } = await loadStoreForUpdate(options);
  existing[provider] = apiKey;
  await backend.save(existing);
}

export async function saveOAuthTokens(tokens: OpenAIOAuthTokens, options?: string | AuthStoreOptions): Promise<void> {
  const { backend, store: existing } = await loadStoreForUpdate(options);
  existing.chatgpt_oauth = tokens;
  await backend.save(existing);
}

export async function removeAuthKey(provider: ProviderName, options?: string | AuthStoreOptions): Promise<void> {
  const { backend, store: existing } = await loadStoreForUpdate(options);
  delete existing[provider];
  if (Object.keys(existing).length === 0) {
    await backend.delete();
    return;
  }
  await backend.save(existing);
}

export async function removeOAuthTokens(options?: string | AuthStoreOptions): Promise<void> {
  const { backend, store: existing } = await loadStoreForUpdate(options);
  delete existing.chatgpt_oauth;
  if (Object.keys(existing).length === 0) {
    await backend.delete();
    return;
  }
  await backend.save(existing);
}

export async function loadOAuthTokens(options?: string | AuthStoreOptions): Promise<OpenAIOAuthTokens | undefined> {
  const keys = await loadAuthStore(options);
  return keys.chatgpt_oauth;
}

export function __setKeytarForTests(keytar: KeyringAdapter | null): void {
  keytarOverride = keytar;
  keytarPromise = null;
}

export function __resetEphemeralAuthStoreForTests(): void {
  ephemeralStore.clear();
}
