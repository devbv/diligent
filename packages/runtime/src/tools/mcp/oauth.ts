// @summary HTTP OAuth for remote MCP servers — token store, provider, loopback login, refresh

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpHttpServerConfig, McpOAuthConfig } from "./types";

export interface McpOAuthDeps {
  /** Directory where per-server OAuth state is persisted (e.g. `<diligentDir>/mcp-oauth`). */
  storeDir: string;
  /** Opens the authorization URL in the user's browser. */
  openBrowser: (url: string) => void;
  /** Loopback callback port (must be free). Defaults to 8976. */
  redirectPort?: number;
}

export interface McpOAuthHandle {
  provider: OAuthClientProvider;
  /** Waits for the loopback redirect to deliver an authorization code. Bounded by `timeoutMs`. */
  waitForCallback(timeoutMs: number): Promise<string>;
  /** Releases the loopback server and any pending waiter. */
  close(): void;
}

const DEFAULT_REDIRECT_PORT = 8976;

/** Static headers / `{env:VAR}` bearer tokens take precedence over OAuth. */
export function resolveAuthHeaders(config: McpHttpServerConfig): Record<string, string> {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  const hasAuth = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
  if (!hasAuth && config.bearerTokenEnvVar) {
    const token = process.env[config.bearerTokenEnvVar];
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** OAuth applies only when no explicit Authorization header is configured and it is not disabled. */
export function shouldUseOAuth(config: McpHttpServerConfig): boolean {
  if (config.oauth?.enabled === false) return false;
  const headers = resolveAuthHeaders(config);
  return !Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

function sanitizeKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

interface PersistedOAuthState {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/** File-backed store of OAuth state for a single MCP server. */
export class FileOAuthStore {
  constructor(private readonly filePath: string) {}

  private async read(): Promise<PersistedOAuthState> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as PersistedOAuthState;
    } catch {
      return {};
    }
  }

  private async write(state: PersistedOAuthState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  async patch(partial: PersistedOAuthState): Promise<void> {
    await this.write({ ...(await this.read()), ...partial });
  }

  async getTokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens;
  }
  async getClientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return (await this.read()).clientInformation;
  }
  async getCodeVerifier(): Promise<string | undefined> {
    return (await this.read()).codeVerifier;
  }
}

class McpOAuthClientProvider implements OAuthClientProvider {
  constructor(
    private readonly store: FileOAuthStore,
    private readonly redirectUri: string,
    private readonly oauthConfig: McpOAuthConfig | undefined,
    private readonly onRedirect: (url: URL) => void | Promise<void>,
  ) {}

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Diligent",
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: this.oauthConfig?.scopes?.join(" "),
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const stored = await this.store.getClientInformation();
    if (stored) return stored;
    // A pre-registered client id lets us skip dynamic client registration for servers
    // that do not support it (e.g. GitHub's remote MCP).
    if (this.oauthConfig?.clientId) return { client_id: this.oauthConfig.clientId };
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.store.patch({ clientInformation: info });
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.store.getTokens();
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.patch({ tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.patch({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.store.getCodeVerifier();
    if (!verifier) throw new Error("Missing PKCE code verifier for MCP OAuth flow");
    return verifier;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createMcpOAuthHandle(
  serverName: string,
  deps: McpOAuthDeps,
  oauthConfig: McpOAuthConfig | undefined,
): McpOAuthHandle {
  const port = deps.redirectPort ?? DEFAULT_REDIRECT_PORT;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const store = new FileOAuthStore(join(deps.storeDir, `${sanitizeKey(serverName)}.json`));
  const codeWaiter = defer<string>();
  let server: Server | undefined;

  const ensureServer = (): void => {
    if (server) return;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif"><h3>${
          code ? "Login complete" : "Login failed"
        }</h3><p>You can close this tab and return to Diligent.</p></body></html>`,
      );
      if (code) codeWaiter.resolve(code);
      else codeWaiter.reject(new Error(`MCP OAuth login failed: ${error ?? "no authorization code"}`));
    });
    // Bind failures (e.g. port already in use) must surface as a clear login error instead
    // of an uncaught async exception that crashes the process.
    server.on("error", (err: NodeJS.ErrnoException) => {
      const detail =
        err.code === "EADDRINUSE"
          ? `loopback callback port ${port} is already in use (set a free one if needed)`
          : err.message;
      codeWaiter.reject(new Error(`MCP OAuth callback server failed: ${detail}`));
    });
    server.listen(port, "127.0.0.1");
  };

  const provider = new McpOAuthClientProvider(store, redirectUri, oauthConfig, (url) => {
    ensureServer();
    deps.openBrowser(url.toString());
  });

  return {
    provider,
    async waitForCallback(timeoutMs: number): Promise<string> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          codeWaiter.promise,
          new Promise<string>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`MCP OAuth login for "${serverName}" timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    close(): void {
      server?.close();
      server = undefined;
    },
  };
}
