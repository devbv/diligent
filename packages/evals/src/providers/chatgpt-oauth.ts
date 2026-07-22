// @summary Local-only ChatGPT OAuth lifecycle and provider binding for live eval profiles
import type { OpenAIOAuthTokens } from "@diligent/core/auth";
import { refreshOAuthTokens, shouldRefresh } from "@diligent/core/auth/chatgpt-oauth";
import { EventStream } from "@diligent/core/event-stream";
import {
  type ExternalProviderAuth,
  type Model,
  type NativeCompactFn,
  ProviderError,
  ProviderErrorType,
  type ProviderEvent,
  type ProviderManager,
  type ProviderResult,
  type StreamContext,
  type StreamFunction,
  type StreamOptions,
} from "@diligent/core/provider-contract";
import { createChatGPTNativeCompaction, createChatGPTStream } from "@diligent/core/providers/chatgpt";
import { type AuthStoreOptions, loadOAuthTokens, runChatGPTOAuth, saveOAuthTokens } from "@diligent/runtime/auth";
import { loadDiligentConfig } from "@diligent/runtime/config";

type InteractiveLoginReason = "missing" | "relogin";

export interface ChatGPTEvalAuthDependencies {
  load: () => Promise<OpenAIOAuthTokens | undefined>;
  save: (tokens: OpenAIOAuthTokens) => Promise<void>;
  refresh: (tokens: OpenAIOAuthTokens) => Promise<OpenAIOAuthTokens>;
  login: (reason: InteractiveLoginReason) => Promise<OpenAIOAuthTokens>;
  shouldRefresh: (tokens: OpenAIOAuthTokens) => boolean;
  createStream: (getTokens: () => OpenAIOAuthTokens) => StreamFunction;
  createNativeCompaction: (getTokens: () => OpenAIOAuthTokens) => NativeCompactFn;
  onStatus?: (status: string) => void;
  onCredentials?: (tokens: OpenAIOAuthTokens) => void;
}

export class ChatGPTEvalAuth {
  private tokens: OpenAIOAuthTokens | undefined;
  private reLoginUsed = false;
  private readonly providerStream: StreamFunction;
  private readonly nativeCompaction: NativeCompactFn;
  private readonly externalAuth: ExternalProviderAuth;

  readonly streamFunction: StreamFunction;

  constructor(private readonly dependencies: ChatGPTEvalAuthDependencies) {
    this.providerStream = dependencies.createStream(() => this.getTokens());
    const providerCompaction = dependencies.createNativeCompaction(() => this.getTokens());
    this.nativeCompaction = (input) => this.runAuthenticated(() => providerCompaction(input));
    this.streamFunction = (model, context, options) => this.createAuthenticatedStream(model, context, options);
    this.externalAuth = {
      isConfigured: () => this.tokens !== undefined,
      ensureFresh: () => this.ensureFresh(),
      getStream: () => this.streamFunction,
      getNativeCompaction: () => this.nativeCompaction,
    };
  }

  async initialize(): Promise<void> {
    const stored = await this.dependencies.load();
    if (!stored) {
      await this.interactiveLogin("missing");
      return;
    }
    this.setTokens(stored);
    this.dependencies.onStatus?.("credentials_loaded");
    await this.ensureFresh();
  }

  bindProviderManager(manager: ProviderManager): void {
    manager.setExternalAuth("chatgpt", this.externalAuth);
  }

  redactionSecrets(): string[] {
    return getChatGPTRedactionSecrets(this.getTokens());
  }

  private getTokens(): OpenAIOAuthTokens {
    if (!this.tokens) throw new Error("ChatGPT OAuth is not initialized for evals.");
    return this.tokens;
  }

  private async ensureFresh(): Promise<void> {
    const current = this.getTokens();
    if (!this.dependencies.shouldRefresh(current)) return;
    this.dependencies.onStatus?.("refreshing_credentials");
    try {
      const refreshed = await this.dependencies.refresh(current);
      await this.dependencies.save(refreshed);
      this.setTokens(refreshed);
      this.dependencies.onStatus?.("credentials_refreshed");
    } catch (error) {
      if (!(await this.recoverAuthentication(error))) throw error;
    }
  }

  private async interactiveLogin(reason: InteractiveLoginReason): Promise<void> {
    this.dependencies.onStatus?.(reason === "missing" ? "opening_browser" : "opening_browser_for_relogin");
    const loggedIn = await this.dependencies.login(reason);
    await this.dependencies.save(loggedIn);
    this.setTokens(loggedIn);
    this.dependencies.onStatus?.("credentials_saved");
  }

  private async recoverAuthentication(error: unknown): Promise<boolean> {
    if (!isClearChatGPTAuthenticationFailure(error) || this.reLoginUsed) return false;
    this.reLoginUsed = true;
    await this.interactiveLogin("relogin");
    return true;
  }

  private setTokens(tokens: OpenAIOAuthTokens): void {
    this.tokens = tokens;
    this.dependencies.onCredentials?.(tokens);
  }

  private async runAuthenticated<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.ensureFresh();
      return await operation();
    } catch (error) {
      if (!(await this.recoverAuthentication(error))) throw error;
      return operation();
    }
  }

  private createAuthenticatedStream(
    model: Model,
    context: StreamContext,
    options: StreamOptions,
  ): EventStream<ProviderEvent, ProviderResult> {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        if (event.type === "error") throw event.error;
        throw new Error("ChatGPT eval stream completed without a terminal event.");
      },
    );
    if (options.signal) stream.attachSignal(options.signal);
    const work = this.pumpStream(stream, model, context, options).catch((error) => {
      stream.push({ type: "error", error: error instanceof Error ? error : new Error(String(error)) });
    });
    stream.setInnerWork(work);
    return stream;
  }

  private async pumpStream(
    target: EventStream<ProviderEvent, ProviderResult>,
    model: Model,
    context: StreamContext,
    options: StreamOptions,
  ): Promise<void> {
    await this.ensureFresh();
    const source = this.providerStream(model, context, options);
    void source.result().catch(() => {});
    let terminalError: Error | undefined;
    let terminalSeen = false;
    for await (const event of source) {
      if (event.type === "error") {
        terminalSeen = true;
        terminalError = event.error;
        break;
      }
      if (event.type === "done") terminalSeen = true;
      target.push(event);
    }
    await source.waitForInnerWork();
    if (!terminalError) {
      if (!terminalSeen) throw new Error("ChatGPT eval provider stream ended without a terminal event.");
      return;
    }
    if (await this.recoverAuthentication(terminalError)) {
      await this.pumpStream(target, model, context, options);
      return;
    }
    target.push({ type: "error", error: terminalError });
  }
}

export function getChatGPTRedactionSecrets(tokens: OpenAIOAuthTokens): string[] {
  return [
    tokens.access_token,
    tokens.refresh_token,
    tokens.id_token,
    tokens.account_id,
    tokens.account_info?.email,
    tokens.account_info?.chatgpt_user_id,
    tokens.account_info?.chatgpt_account_id,
  ].filter((value): value is string => Boolean(value));
}

export async function createLocalChatGPTEvalAuth(
  cwd: string,
  options?: {
    onStatus?: (status: string) => void;
    onCredentials?: (tokens: OpenAIOAuthTokens) => void;
  },
): Promise<ChatGPTEvalAuth> {
  const authStore = await resolveCanonicalAuthStore(cwd);
  const auth = new ChatGPTEvalAuth({
    load: () => loadOAuthTokens(authStore),
    save: (tokens) => saveOAuthTokens(tokens, authStore),
    refresh: refreshOAuthTokens,
    login: () => runChatGPTOAuth(),
    shouldRefresh,
    createStream: createChatGPTStream,
    createNativeCompaction: createChatGPTNativeCompaction,
    onStatus: options?.onStatus,
    onCredentials: options?.onCredentials,
  });
  await auth.initialize();
  return auth;
}

export function isClearChatGPTAuthenticationFailure(error: unknown): boolean {
  if (error instanceof ProviderError && error.errorType === ProviderErrorType.Auth) return true;
  const status = readNumericProperty(error, "statusCode") ?? readNumericProperty(error, "status");
  if (status === 401) return true;
  const message = error instanceof Error ? error.message : "";
  if (/ChatGPT native compaction failed \(401\)/i.test(message)) return true;
  if (/Token refresh failed \(401\)/i.test(message)) return true;
  return /Token refresh failed \(400\):[\s\S]*invalid_grant/i.test(message);
}

async function resolveCanonicalAuthStore(cwd: string): Promise<AuthStoreOptions> {
  const { config } = await loadDiligentConfig(cwd);
  return { mode: config.provider?.auth?.credentialsStore ?? "auto" };
}

function readNumericProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : undefined;
}
