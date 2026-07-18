// @summary Intercepts Web-owned consent requests before the closed Diligent runtime protocol

import type { JSONRPCResponse } from "@diligent/protocol";
import { ConsentSetParamsSchema, WEB_CONSENT_SET_METHOD, type WebConsentBackend } from "../shared/consent-protocol";

interface WebRequestRouterOptions {
  consentBackend?: WebConsentBackend;
  send(message: JSONRPCResponse): void;
  forward(raw: string | Buffer): void;
}

export async function routeWebRpcRequest(raw: string | Buffer, options: WebRequestRouterOptions): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    options.forward(raw);
    return;
  }

  if (!isConsentRequest(value)) {
    options.forward(raw);
    return;
  }

  const id = typeof value.id === "string" || typeof value.id === "number" ? value.id : "unknown";
  if (id === "unknown") {
    options.send({ id, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  if (!options.consentBackend) {
    options.send({ id, error: { code: -32601, message: "Consent backend not available" } });
    return;
  }

  const params = ConsentSetParamsSchema.safeParse(value.params ?? {});
  if (!params.success) {
    options.send({ id, error: { code: -32602, message: "Invalid params", data: params.error.message } });
    return;
  }

  try {
    const result = await options.consentBackend.set(params.data);
    options.send({ id, result });
  } catch (error) {
    const code =
      error instanceof Error && typeof (error as Error & { code?: unknown }).code === "number"
        ? (error as Error & { code: number }).code
        : -32000;
    options.send({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
  }
}

function isConsentRequest(value: unknown): value is { id: unknown; method: string; params?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "method" in value &&
    (value as { method?: unknown }).method === WEB_CONSENT_SET_METHOD
  );
}
