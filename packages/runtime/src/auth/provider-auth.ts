// @summary ChatGPT OAuth provider auth binding for core ProviderManager injection
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenAIOAuthTokens } from "@diligent/core/auth";
import { refreshOAuthTokens, shouldRefresh } from "@diligent/core/auth/chatgpt-oauth";
import { EventStream } from "@diligent/core/event-stream";
import {
  type ChatGPTStreamOptions,
  createChatGPTNativeCompaction,
  createChatGPTStream,
} from "@diligent/core/llm/provider/chatgpt";
import { createVertexStream } from "@diligent/core/llm/provider/vertex";
import type { ExternalProviderAuth } from "@diligent/core/llm/provider-manager";
import type { ProviderEvent, ProviderResult, StreamFunction } from "@diligent/core/llm/types";

export interface ChatGPTOAuthBinding {
  auth: ExternalProviderAuth;
  setTokens: (tokens: OpenAIOAuthTokens) => void;
  clearTokens: () => void;
  getTokens: () => OpenAIOAuthTokens | undefined;
}

export interface VertexProviderConfig {
  project: string;
  location: string;
  endpoint: string;
  baseUrl?: string;
  authMode?: "access_token_command" | "access_token" | "adc";
  accessToken?: string;
  accessTokenCommand?: string;
  modelMap?: Record<string, string>;
}

export interface VertexAccessTokenBinding {
  auth: ExternalProviderAuth;
  refresh: () => Promise<void>;
  getToken: () => string | undefined;
}

export function createChatGPTOAuthBinding(args?: {
  initialTokens?: OpenAIOAuthTokens;
  onTokensRefreshed?: (tokens: OpenAIOAuthTokens) => Promise<void>;
  streamOptions?: ChatGPTStreamOptions;
}): ChatGPTOAuthBinding {
  let oauthTokens = args?.initialTokens;
  let refreshLock: Promise<void> | undefined;

  const setTokens = (tokens: OpenAIOAuthTokens): void => {
    oauthTokens = tokens;
  };

  const clearTokens = (): void => {
    oauthTokens = undefined;
  };

  const getTokens = (): OpenAIOAuthTokens | undefined => oauthTokens;

  const ensureFresh = async (): Promise<void> => {
    if (!oauthTokens || !shouldRefresh(oauthTokens)) return;

    if (!refreshLock) {
      refreshLock = (async () => {
        try {
          const refreshed = await refreshOAuthTokens(oauthTokens!);
          oauthTokens = refreshed;
          await args?.onTokensRefreshed?.(refreshed).catch(() => {});
        } finally {
          refreshLock = undefined;
        }
      })();
    }

    await refreshLock;
  };

  const stream = createChatGPTStream(() => oauthTokens!, args?.streamOptions);

  const auth: ExternalProviderAuth = {
    isConfigured: () => oauthTokens !== undefined,
    getMaskedKey: () => (oauthTokens ? "ChatGPT OAuth" : undefined),
    getStream: () => stream,
    getNativeCompaction: () => createChatGPTNativeCompaction(() => oauthTokens!),
    ensureFresh,
  };

  return { auth, setTokens, clearTokens, getTokens };
}

export function createVertexAccessTokenBinding(config: VertexProviderConfig): VertexAccessTokenBinding {
  let accessToken = config.accessToken?.trim();
  let expiresAt = accessToken ? Date.now() + 45 * 60 * 1000 : undefined;
  let refreshLock: Promise<void> | undefined;

  const refresh = async (): Promise<void> => {
    if (config.authMode === "access_token" || (!config.authMode && accessToken)) return;
    if (!refreshLock) {
      refreshLock = (async () => {
        try {
          const command = resolveVertexTokenCommand(config);
          const proc = Bun.spawn(await resolveVertexTokenCommandArgs(command), {
            stdout: "pipe",
            stderr: "pipe",
            env: process.env as Record<string, string>,
          });
          const [exitCode, stdoutText, stderrText] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          if (exitCode !== 0) {
            throw new Error(stderrText.trim() || `Vertex token command failed with exit code ${exitCode}`);
          }
          const nextToken = stdoutText.trim();
          if (!nextToken) throw new Error("Vertex token command returned an empty token");
          accessToken = nextToken;
          expiresAt = Date.now() + 45 * 60 * 1000;
        } finally {
          refreshLock = undefined;
        }
      })();
    }
    await refreshLock;
  };

  const ensureFresh = async (): Promise<void> => {
    if (config.authMode === "access_token" || (!config.authMode && accessToken)) return;
    if (!accessToken || !expiresAt || expiresAt - Date.now() <= 5 * 60 * 1000) {
      await refresh();
    }
  };

  const auth: ExternalProviderAuth = {
    isConfigured: () => Boolean(accessToken || config.accessTokenCommand || config.authMode === "adc"),
    getMaskedKey: () => {
      if (config.authMode === "access_token" || (!config.authMode && accessToken)) return "Vertex access token";
      if (config.authMode === "adc") return "Vertex ADC";
      return config.accessTokenCommand ? "Vertex token command" : undefined;
    },
    getStream: () =>
      createDeferredVertexStream(
        async () => {
          await ensureFresh();
          if (!accessToken) throw new Error("Vertex access token is not available");
          return accessToken;
        },
        {
          baseUrl: config.baseUrl ?? buildVertexBaseUrl(config.project, config.location, config.endpoint),
          modelMap: config.modelMap,
        },
      ),
    ensureFresh,
  };

  return {
    auth,
    refresh,
    getToken: () => accessToken,
  };
}

function buildVertexBaseUrl(project: string, location: string, endpoint: string): string {
  const normalizedLocation = location.trim();
  const host =
    normalizedLocation === "global" ? "aiplatform.googleapis.com" : `${normalizedLocation}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${normalizedLocation}/endpoints/${endpoint}`;
}

function resolveVertexTokenCommand(config: VertexProviderConfig): string {
  if (config.accessTokenCommand?.trim()) return config.accessTokenCommand.trim();
  if (config.authMode === "adc") return "gcloud auth application-default print-access-token";
  throw new Error("Vertex accessTokenCommand is required for command-based auth");
}

async function resolveVertexTokenCommandArgs(command: string): Promise<string[]> {
  if (process.platform === "win32") {
    const trimmed = command.trim();
    if (trimmed === "gcloud auth application-default print-access-token") {
      const gcloudCommand = await resolveWindowsGcloudCommand();
      if (gcloudCommand !== "gcloud.cmd") {
        return [gcloudCommand, "auth", "application-default", "print-access-token"];
      }

      return ["cmd.exe", "/d", "/s", "/c", "gcloud.cmd auth application-default print-access-token"];
    }

    return ["powershell", "-NoProfile", "-Command", command];
  }

  return ["bash", "-lc", command];
}

async function resolveWindowsGcloudCommand(): Promise<string> {
  const discovered = await findWindowsGcloudOnPath();
  if (discovered) return discovered;

  for (const candidate of getWindowsGcloudCandidates()) {
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }

  return "gcloud.cmd";
}

async function findWindowsGcloudOnPath(): Promise<string | undefined> {
  const pathEntries = (process.env.PATH ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of pathEntries) {
    const candidate = join(entry, "gcloud.cmd");
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }

  try {
    const proc = Bun.spawn(["where.exe", "gcloud.cmd"], {
      stdout: "pipe",
      stderr: "ignore",
      env: process.env as Record<string, string>,
    });
    const [exitCode, stdoutText] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (exitCode === 0) {
      const match = stdoutText
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.toLowerCase().endsWith("gcloud.cmd"));
      if (match) return match;
    }
  } catch {
    // Ignore lookup failures and continue with known install locations.
  }

  return undefined;
}

function getWindowsGcloudCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const userProfile = process.env.USERPROFILE?.trim() ?? homedir();
  const programFiles = process.env.ProgramFiles?.trim();
  const programFilesX86 = process.env["ProgramFiles(x86)"]?.trim();

  const roots = [
    localAppData,
    userProfile ? join(userProfile, "AppData", "Local") : undefined,
    programFiles,
    programFilesX86,
  ].filter((value): value is string => Boolean(value));

  return roots.map((root) => join(root, "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud.cmd"));
}

function createDeferredVertexStream(
  getAccessToken: () => Promise<string>,
  config: { baseUrl: string; modelMap?: Record<string, string> },
): StreamFunction {
  return (model, context, options) => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    if (options.signal) stream.attachSignal(options.signal);

    const work = (async () => {
      try {
        const token = await getAccessToken();
        if (options.signal?.aborted) return;
        const inner = createVertexStream(() => token, config)(model, context, options);
        for await (const event of inner) {
          stream.push(event);
        }
        await inner.result();
      } catch (error) {
        stream.push({
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    })();

    stream.setInnerWork(work);
    return stream;
  };
}
