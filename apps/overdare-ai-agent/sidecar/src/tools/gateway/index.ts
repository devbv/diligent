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
import type { StudioToolProviderOptions } from "../hello-world";
import { maskValue } from "./masking";
import { DEBUG, resolveEndpoint, resolveToken } from "./shared";

/** POST /v1/records body — see ~/git/diligent-gateway/contract/envelope.schema.json. */
interface RecordEnvelope {
  project_id: string;
  user_id: string;
  session_id: string;
  seq: number;
  event_ts: string;
  record: Record<string, unknown>;
}

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
