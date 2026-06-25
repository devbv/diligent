// @summary OVERDARE gateway transmitter — an async "EntryAppended" hook that POSTs each session
// record to diligent-gateway (OVDR-11475 §B, MVP).
//
// Implemented as a plugin hook with `mode: "async"`: the runtime's hook runner detaches it, so a
// slow/unreachable gateway never blocks the write or turn path. MVP scope: mask → single POST,
// no durable outbox / batch / retry yet. Consent gating (serviceImprovement) happens upstream in
// the runtime, so this hook only runs when the user has opted in.
//
// Auth: the per-user bearer is the **Creator Hub token** fetched via Studio RPC — the same token
// bubo/analytics uses (shared `readHubToken`, cached). `DILIGENT_GATEWAY_TOKEN` is honoured as a
// local-dev override when set.

import type { BundledToolProvider, HookInput, PluginHookFn } from "@diligent/runtime";
import { loadOverdareConfig, readHubToken } from "../analytics";
import type { StudioToolProviderOptions } from "../hello-world";
import { maskValue } from "./masking";

const PROD_GATEWAY_URL = "https://diligent-gateway-prod.ovdr.io";
const DEV_GATEWAY_URL = "https://diligent-gateway-dev.ovdr.io";
/** Hub domain that identifies the production environment (mirrors bubo's analytics host selection). */
const PROD_HUB_DOMAIN = "https://create.overdare.com";

/** POST /v1/records body — see ~/git/diligent-gateway/contract/envelope.schema.json. */
interface RecordEnvelope {
  project_id: string;
  user_id: string;
  session_id: string;
  seq: number;
  event_ts: string;
  record: Record<string, unknown>;
}

/**
 * Default gateway host by environment: prod when `HUB_DOMAIN` is the production hub, dev otherwise.
 * Mirrors bubo's `resolveDefaultBuboHost` so the gateway follows the same env switch.
 */
function resolveDefaultGatewayUrl(): string {
  const hubDomain = (process.env.HUB_DOMAIN ?? "").trim().replace(/\/+$/, "").toLowerCase();
  return hubDomain === PROD_HUB_DOMAIN ? PROD_GATEWAY_URL : DEV_GATEWAY_URL;
}

function resolveEndpoint(): string {
  const raw = process.env.DILIGENT_GATEWAY_URL?.trim() || resolveDefaultGatewayUrl();
  return raw.replace(/\/+$/, ""); // drop trailing slash(es) so `${endpoint}/v1/records` is well-formed
}

/**
 * Resolve the bearer token: a `DILIGENT_GATEWAY_TOKEN` env override (local dev) if set, otherwise
 * the Creator Hub token via Studio RPC (same source as bubo). Returns undefined if unavailable.
 */
async function resolveToken(): Promise<string | undefined> {
  const override = process.env.DILIGENT_GATEWAY_TOKEN?.trim();
  if (override) return override;
  try {
    return await readHubToken(loadOverdareConfig());
  } catch {
    return undefined; // hub token unavailable (no Studio RPC) — stay disabled
  }
}

const DEBUG = Boolean(process.env.DILIGENT_GATEWAY_DEBUG?.trim());

export function createGatewayToolProvider(options: StudioToolProviderOptions): BundledToolProvider {
  const explicitProjectId = options.projectId?.trim() ?? "";
  const cwd = options.cwd?.trim() ?? "";

  const onEntryAppended: PluginHookFn = async (input) => {
    const userId = resolveUserId(input);
    // When Studio did not inject a project id (OVERDARE_PROJECT_ID unset), fall back to a
    // `<user_id>:<cwd>` synthetic id so records are still attributable per user+workspace.
    // `:`, `/` and `\` are replaced with `_` so the id stays free of path/separator characters.
    const projectId = explicitProjectId || `${userId}:${cwd}`.replace(/[:/\\]/g, "_");
    const token = await resolveToken();
    if (token) await postRecord(input, projectId, userId, token);
    return { blocked: false };
  };
  // Detached by the hook runner — never blocks the write/turn path.
  onEntryAppended.mode = "async";

  return {
    id: "@overdare/gateway-transmit",
    displayName: "OVERDARE Gateway Transmit",
    createTools: () => [],
    onEntryAppended,
  };
}

/** Resolve a non-empty user id from the hook input, defaulting to "unknown". */
function resolveUserId(input: HookInput): string {
  return typeof input.user_id === "string" && input.user_id.trim() ? input.user_id.trim() : "unknown";
}

async function postRecord(input: HookInput, projectId: string, userId: string, token: string): Promise<void> {
  const entry = (input.entry ?? {}) as Record<string, unknown>;
  const eventTs = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();

  const envelope: RecordEnvelope = {
    project_id: projectId,
    user_id: userId,
    session_id: input.session_id,
    seq: typeof input.seq === "number" ? input.seq : 0,
    event_ts: eventTs,
    record: maskValue(entry),
  };

  // Fire-and-forget MVP: best-effort, no retry/outbox yet (next phase). Errors are swallowed
  // unless DILIGENT_GATEWAY_DEBUG is set, so transmission can be inspected during testing.
  try {
    const res = await fetch(`${resolveEndpoint()}/v1/records`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(envelope),
    });
    if (DEBUG) {
      const body = await res.text().catch(() => "");
      console.error(`[gateway] ${envelope.session_id}#${envelope.seq} → ${res.status} ${body}`.trim());
    }
  } catch (err) {
    if (DEBUG) {
      console.error(`[gateway] ${envelope.session_id}#${envelope.seq} failed:`, err);
    }
  }
}
