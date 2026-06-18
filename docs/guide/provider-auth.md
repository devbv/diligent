# Provider auth

This guide describes the current provider authentication model in Diligent.

## Overview

Diligent currently supports two broad auth paths:

- API-key-backed providers
- runtime-managed ChatGPT OAuth

These auth flows are runtime-managed and shared across clients through the app-server RPC surface.

Supported providers in the protocol/runtime are:

- `anthropic`
- `openai`
- `chatgpt`
- `gemini`
- `vertex`
- `zai`

## Auth storage

Auth state is persisted using `provider.auth.credentialsStore`, which defaults to `auto`:

- `auto`: prefer OS keyring, fall back to `~/.diligent/auth.jsonc`
- `keyring`: require OS keyring storage
- `file`: always use `~/.diligent/auth.jsonc`
- `ephemeral`: process-local in-memory storage only

In keyring-backed modes, the full auth payload is serialized as JSON and stored in the OS credential store. Diligent does not add its own encryption layer; protection is delegated to the OS keychain / credential manager. Successful keyring writes remove any stale fallback auth file.

The auth store uses JSONC parsing and supports `{env:VAR}` substitution when values are read. The stored schema is strict, and invalid content falls back to an empty auth state rather than partially loading unknown fields.

File-backed auth writes create parent directories as needed and tighten file permissions after write.

Example config:

```jsonc
{
  "provider": {
    "auth": {
      "credentialsStore": "auto"
    }
  }
}
```

Current persisted shape:

```jsonc
{
  "anthropic": "sk-ant-...", // optional
  "openai": "sk-...", // optional
  "chatgpt": "...", // optional, legacy/plain-key slot
  "gemini": "AIza...", // optional
  "zai": "zai_...", // optional
  "chatgpt_oauth": {
    "access_token": "...",
    "refresh_token": "...",
    "id_token": "...",
    "expires_at": 1735689600000,
    "account_id": "..." // optional
  }
}
```

Notes:

- In the current app-server flow, ChatGPT authentication uses `chatgpt_oauth` (not `chatgpt` API key).
- `{env:VAR}` expansion happens on read and unresolved env vars become an empty string.
- If the file has unknown fields, the strict schema rejects the content and runtime treats auth as empty (`{}`).

## API key flow

The auth store currently supports plain API keys for:

- `anthropic`
- `openai`
- `gemini`
- `zai`

Vertex uses runtime-managed access-token auth instead of a long-lived API key.

## z.ai API-key flow

z.ai support uses the `zai` provider and currently targets the z.ai OpenAI-compatible Chat Completions endpoint for `glm-*` models.

Practical notes:

- configure with `auth/set` or `~/.diligent/auth.jsonc`
- runtime stores the plain API key in the same auth store as other API-key providers
- the default built-in model for this provider is `glm-5.2`
- the default base URL is `https://api.z.ai/api/paas/v4`
- environment fallback is supported through `ZAI_API_KEY`

## Vertex AI access-token flow

Vertex support uses the `vertex` provider and targets the Vertex AI OpenAI-compatible Chat Completions endpoint.

Runtime config shape:

```jsonc
{
  "model": "vertex-gemma-4-26b-it",
  "provider": {
    "vertex": {
      "project": "my-gcp-project",
      "location": "global",
      "endpoint": "openapi",
      "authMode": "adc"
    }
  }
}
```

Supported initial auth modes:

- `access_token_command`
- `access_token`
- `adc`

Current behavior:

- `access_token_command` runs a local command and uses trimmed stdout as the bearer token
- `adc` uses the command-backed refresh path and defaults to `gcloud auth application-default print-access-token`
- runtime runs that command through `bash -lc` on Unix-like platforms
- on Windows, the default ADC command is invoked via `cmd.exe /d /s /c "gcloud.cmd auth application-default print-access-token"` to avoid PowerShell execution-policy issues and `.cmd` spawn resolution differences
- custom `access_token_command` values on Windows still run through `powershell -NoProfile -Command`
- `access_token` uses a static token supplied in config
- `project`, `location`, and `endpoint` are required when `provider.vertex` is present
- if `baseUrl` is omitted, runtime derives it from `project`, `location`, and `endpoint`
- for MAAS publisher models that are global-only, set `location` to `global`

Vertex auth is bound into `ProviderManager` as external auth, similar to ChatGPT OAuth in lifecycle shape but without browser OAuth.

These keys are loaded by runtime and then bound into provider access through shared provider-auth wiring.

At runtime startup:

1. `loadAuthStore()` reads `auth.jsonc`
2. plain string keys are injected into `ProviderManager` via `setApiKey(...)`
3. provider/model availability is derived from configured providers

API-key operations over RPC:

- `auth/set` stores a key and updates `ProviderManager`
- `auth/remove` deletes a key and updates `ProviderManager`

After each update, server emits `account/updated` with fresh provider status.

## ChatGPT OAuth flow

ChatGPT OAuth is a separate auth path.

- `chatgpt` does not use `auth/set` API-key storage
- OAuth start is triggered through `auth/oauth/start`
- OAuth is currently specific to the ChatGPT provider path

The current flow uses PKCE, a local callback server, and runtime-managed token persistence.

Concrete flow:

1. Client calls `auth/oauth/start` with `{ provider: "chatgpt" }`
2. Runtime creates PKCE request and opens browser to `https://auth.openai.com/oauth/authorize`
3. Runtime waits on local callback: `http://localhost:1455/auth/callback`
4. Runtime exchanges auth code at `https://auth.openai.com/oauth/token`
5. Runtime stores `chatgpt_oauth` tokens in the configured auth credential store
6. Runtime binds ChatGPT external auth into `ProviderManager`
7. Runtime emits:
   - `account/login/completed` (success/failure)
   - `account/updated` (provider status refresh)

Behavioral constraints:

- OAuth start only accepts `provider: "chatgpt"`
- concurrent OAuth starts are rejected (`OAuth flow already in progress`)
- current callback wait timeout is 5 minutes

## Refresh and runtime binding

Runtime binds external auth into `ProviderManager` and refreshes ChatGPT OAuth tokens automatically before provider use when needed.

Refresh handling is serialized so concurrent refresh attempts do not race each other.

Refresh specifics:

- tokens are considered refresh-needed when expiry is within 5 minutes
- refresh uses `grant_type=refresh_token`
- refreshed tokens are persisted through the binding callback (`onTokensRefreshed`)

Important current behavior:

- on request dispatch, `ProviderManager` triggers `ensureFresh()` without awaiting it
- this means first request near expiry may race with refresh; subsequent requests use refreshed tokens once saved

## RPC and UI surface

The current auth-related RPC surface is:

- `auth/list`
- `auth/set`
- `auth/remove`
- `auth/oauth/start`

The server also emits account/auth-related notifications so clients can refresh visible provider state after login or account changes.

Payload highlights:

- `auth/list` returns:
  - `providers: ProviderAuthStatus[]`
  - `availableModels: ModelInfo[]`
- `ProviderAuthStatus` includes:
  - `provider`
  - `configured`
  - `maskedKey` (optional)
  - `oauthConnected` (optional, currently used for ChatGPT)

Current client behavior:

- Web listens to both `account/login/completed` and `account/updated`
- TUI waits for `account/login/completed` during `/provider set chatgpt`
- app-server opens external browser server-side (important for Desktop/Tauri integration)

## Practical notes

- API key auth and ChatGPT OAuth are intentionally distinct flows
- Auth state is user-global, while project continuity remains project-local
- Runtime owns auth persistence and refresh logic; clients mainly initiate actions and reflect resulting state

Failure/edge cases to expect:

- invalid or schema-mismatched `auth.jsonc` is ignored as empty auth state
- ChatGPT passed to `auth/set` is rejected (`ChatGPT uses OAuth login, not API keys`)
- OAuth callback state mismatch or timeout fails login and emits unsuccessful `account/login/completed`
- removing `chatgpt` auth clears both plain key slot (if any) and `chatgpt_oauth`, then unbinds external auth

## Key code paths

- `packages/runtime/src/auth/auth-store.ts`
- `packages/runtime/src/auth/provider-auth.ts`
- `packages/runtime/src/auth/chatgpt-oauth.ts`
- `packages/runtime/src/app-server/config-handlers.ts`
- `packages/runtime/src/config/runtime.ts`
- `packages/core/src/llm/provider-manager.ts`
- `packages/core/src/auth/types.ts`
- `packages/core/src/auth/chatgpt-oauth/chatgpt-oauth.ts`
- `packages/web/src/client/lib/auth-api.ts`
- `packages/web/src/client/lib/use-provider-manager.ts`
