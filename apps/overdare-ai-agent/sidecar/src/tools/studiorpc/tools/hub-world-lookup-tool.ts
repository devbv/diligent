// @summary Looks up an OVERDARE world by id via the Hub backend to determine existence.

import { z } from "zod";
import { call } from "../rpc";
import type { Tool, ToolResult } from "../types";

const TIMEOUT_MS = 10_000;

const params = z.object({
  worldId: z.number().int().positive().describe("Numeric world id extracted from CommandletArgs.json (ContentId)."),
});

type Params = z.infer<typeof params>;

interface HubTokenReadResult {
  token?: string;
}

async function readHubToken(): Promise<string> {
  const result = (await call("hub.token.read", {})) as HubTokenReadResult | string | undefined;
  if (typeof result === "string" && result.length > 0) return result;
  if (result && typeof result === "object" && typeof result.token === "string" && result.token.length > 0) {
    return result.token;
  }
  throw new Error("Hub auth token is not available. Ask the user to log in to OVERDARE Studio and try again.");
}

function resolveHubDomain(): string {
  const raw = process.env.HUB_DOMAIN?.trim();
  if (!raw) {
    throw new Error(
      "HUB_DOMAIN is not configured for this agent process. Restart the agent with --hub-domain=<domain> set.",
    );
  }
  return raw.replace(/\/+$/, "");
}

export function createHubWorldLookupTool(): Tool {
  return {
    name: "hub_world_lookup",
    description:
      "Check whether a world with the given numeric `worldId` exists on the OVERDARE Hub backend. " +
      "Returns `{ exists: true, world: {...} }` when the backend has the world, or `{ exists: false }` when " +
      "the backend returns 404. HUB_DOMAIN and the Hub auth token are resolved internally — callers do not " +
      "need to supply them. Other network/auth failures throw and should be surfaced to the user.",
    parameters: params,
    supportParallel: true,
    async execute(args: Params): Promise<ToolResult> {
      const domain = resolveHubDomain();
      const token = await readHubToken();

      const url = `${domain}/backend/user/world/worlds/${args.worldId}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (response.status === 404) {
          const payload = { exists: false } as const;
          return {
            output: JSON.stringify(payload, null, 2),
            metadata: { tool: "hub_world_lookup", exists: false, worldId: args.worldId },
          };
        }

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new Error(
              `Hub world lookup failed with HTTP ${response.status}. The Hub auth token was rejected — ask the user to log in again.`,
            );
          }
          const errText = (await response.text()).slice(0, 200);
          throw new Error(`Hub world lookup failed (HTTP ${response.status}): ${errText || response.statusText}`);
        }

        const data = (await response.json()) as Record<string, unknown>;
        const payload = { exists: true, world: data } as const;
        return {
          output: JSON.stringify(payload, null, 2),
          metadata: { tool: "hub_world_lookup", exists: true, worldId: args.worldId },
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`Hub world lookup timed out after ${TIMEOUT_MS}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
