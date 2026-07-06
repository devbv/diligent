// @summary Shared endpoint/auth helpers for the OVERDARE gateway client (records + consent).

import { loadOverdareConfig, readHubToken } from "../analytics";

const PROD_GATEWAY_URL = "http://diligent-gateway-prod.ovdr.io";
const DEV_GATEWAY_URL = "https://diligent-gateway-dev.ovdr.io";
/** Hub domain that identifies the production environment (mirrors bubo's analytics host selection). */
const PROD_HUB_DOMAIN = "https://create.overdare.com";

export const DEBUG = Boolean(process.env.DILIGENT_GATEWAY_DEBUG?.trim());

/**
 * Default gateway host by environment: prod when `HUB_DOMAIN` is the production hub, dev otherwise.
 * Mirrors bubo's `resolveDefaultBuboHost` so the gateway follows the same env switch.
 */
function resolveDefaultGatewayUrl(): string {
  const diligentEnv = process.env.DILIGENT_ENV?.trim().toLowerCase();
  if (diligentEnv === "prod") return PROD_GATEWAY_URL;
  if (diligentEnv === "dev") return DEV_GATEWAY_URL;

  const hubDomain = (process.env.HUB_DOMAIN ?? "").trim().replace(/\/+$/, "").toLowerCase();
  return hubDomain === PROD_HUB_DOMAIN ? PROD_GATEWAY_URL : DEV_GATEWAY_URL;
}

/** Base gateway URL with trailing slash(es) stripped so `${endpoint}/v1/...` is well-formed. */
export function resolveEndpoint(): string {
  const raw = process.env.DILIGENT_GATEWAY_URL?.trim() || resolveDefaultGatewayUrl();
  return raw.replace(/\/+$/, "");
}

/**
 * Resolve the bearer token: a `DILIGENT_GATEWAY_TOKEN` env override (local dev) if set, otherwise
 * the Creator Hub token via Studio RPC (same source as bubo). Returns undefined if unavailable.
 */
export async function resolveToken(): Promise<string | undefined> {
  const override = process.env.DILIGENT_GATEWAY_TOKEN?.trim();
  if (override) return override;
  try {
    return await readHubToken(loadOverdareConfig());
  } catch {
    return undefined; // hub token unavailable (no Studio RPC) — stay disabled
  }
}
