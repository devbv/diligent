// @summary Authenticated loopback endpoint the Rust MCP router calls to execute this sidecar's
// Studio tools and prompts (P071 Task 4). Execution goes through the same registry path as the
// stdio MCP server, so approval metadata, snapshot/rollback hooks, and render payloads cannot drift.

import { timingSafeEqual } from "node:crypto";
import { createLogger } from "@diligent/logging";
import {
  callRegistryTool,
  getRegistryPrompt,
  listRegistryPrompts,
  listRegistryTools,
  type McpRegistries,
} from "./mcp-server";

const logger = createLogger({ scope: "sidecar/router-endpoint" });

/** All router-callable routes live under this prefix so they cannot collide with the web UI. */
export const ROUTER_ROUTE_PREFIX = "/mcp-router";
export const ROUTER_CATALOG_ROUTE = `${ROUTER_ROUTE_PREFIX}/catalog`;
export const ROUTER_TOOL_CALL_ROUTE = `${ROUTER_ROUTE_PREFIX}/tools/call`;
export const ROUTER_PROMPT_GET_ROUTE = `${ROUTER_ROUTE_PREFIX}/prompts/get`;

export interface RouterToolCatalogResponse {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  prompts: Array<{ name: string; description: string }>;
}

export interface RouterToolCallRequest {
  tool: string;
  args: unknown;
  /** Correlates a router-side call with this sidecar's logs. Opaque to execution. */
  routerCallId: string;
}

export interface RouterPromptGetRequest {
  name: string;
  routerCallId?: string;
}

export interface RouterEndpointOptions {
  /** Bearer token from this sidecar's registry record. */
  token: string;
  /** Resolves the MCP registries. Lazy so a slow registry build never delays server startup. */
  registries: () => Promise<McpRegistries>;
}

/** Constant-time bearer comparison so a wrong token cannot be recovered byte-by-byte. */
function tokenMatches(expected: string, presented: string | null): boolean {
  if (!presented) return false;
  const prefix = "Bearer ";
  if (!presented.startsWith(prefix)) return false;
  const actual = Buffer.from(presented.slice(prefix.length));
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** A route group the web server consults before its own routing. */
export interface ExtraRoutes {
  /** Synchronous so the server's `fetch` can dispatch without becoming async. */
  matches: (url: URL) => boolean;
  handle: (req: Request, url: URL) => Response | Promise<Response>;
}

export function routerRouteMatches(url: URL): boolean {
  return url.pathname === ROUTER_ROUTE_PREFIX || url.pathname.startsWith(`${ROUTER_ROUTE_PREFIX}/`);
}

/**
 * Build the router route group.
 *
 * Only paths under {@link ROUTER_ROUTE_PREFIX} match, so the web server keeps its existing routing
 * (WebSocket `/rpc`, `/health`, image routes, static serving, dev fallback) unchanged.
 */
export function createRouterEndpoint(options: RouterEndpointOptions): ExtraRoutes {
  const handle = async (req: Request, url: URL): Promise<Response> => {
    if (!tokenMatches(options.token, req.headers.get("authorization"))) {
      // Deliberately terse: the caller is the local router, and a mismatch is a bug or an
      // unauthorized local process — neither benefits from detail.
      return jsonError(401, "Unauthorized");
    }

    if (url.pathname === ROUTER_CATALOG_ROUTE) {
      if (req.method !== "GET") return jsonError(405, "Method not allowed");
      const registries = await options.registries();
      const body: RouterToolCatalogResponse = {
        tools: listRegistryTools(registries),
        prompts: listRegistryPrompts(registries),
      };
      return Response.json(body);
    }

    if (url.pathname === ROUTER_TOOL_CALL_ROUTE) {
      if (req.method !== "POST") return jsonError(405, "Method not allowed");
      let payload: Partial<RouterToolCallRequest>;
      try {
        payload = (await req.json()) as Partial<RouterToolCallRequest>;
      } catch {
        return jsonError(400, "Invalid JSON body");
      }
      if (typeof payload.tool !== "string" || !payload.tool) {
        return jsonError(400, "Missing 'tool'");
      }
      const registries = await options.registries();
      logger.debug("tool.call", {
        message: `[router] ${payload.tool}`,
        fields: { tool: payload.tool, routerCallId: payload.routerCallId ?? null },
      });
      // A tool that throws is already mapped to an isError result by callRegistryTool, so this
      // stays HTTP 200: the router must forward tool failures to the model, not treat them as a
      // dead sidecar and clear the active Studio.
      return Response.json(await callRegistryTool(registries, payload.tool, payload.args));
    }

    if (url.pathname === ROUTER_PROMPT_GET_ROUTE) {
      if (req.method !== "POST") return jsonError(405, "Method not allowed");
      let payload: Partial<RouterPromptGetRequest>;
      try {
        payload = (await req.json()) as Partial<RouterPromptGetRequest>;
      } catch {
        return jsonError(400, "Invalid JSON body");
      }
      if (typeof payload.name !== "string" || !payload.name) {
        return jsonError(400, "Missing 'name'");
      }
      const registries = await options.registries();
      try {
        return Response.json(await getRegistryPrompt(registries, payload.name));
      } catch (error) {
        return jsonError(404, error instanceof Error ? error.message : String(error));
      }
    }

    return jsonError(404, `Unknown router route: ${url.pathname}`);
  };

  return { matches: routerRouteMatches, handle };
}
