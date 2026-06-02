// @summary Lists valid world categories from the OVERDARE Hub backend.

import { z } from "zod";
import { call } from "../rpc";
import type { Tool, ToolResult } from "../types";

const TIMEOUT_MS = 10_000;

const params = z.object({});

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

export function createHubWorldCategoriesListTool(): Tool {
  return {
    name: "hub_world_categories_list",
    description:
      "List the world category labels accepted by the OVERDARE Hub backend. " +
      "Returns `{ categories: string[] }`. Use the returned values exactly as-is (preserve case) when filling " +
      "the `category` field for `studiorpc_level_publish` on first publish. HUB_DOMAIN and the Hub auth token " +
      "are resolved internally — callers do not need to supply them.",
    parameters: params,
    supportParallel: true,
    async execute(_args: Params): Promise<ToolResult> {
      const domain = resolveHubDomain();
      const token = await readHubToken();

      const url = `${domain}/backend/user/world/categories`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new Error(
              `Hub categories list failed with HTTP ${response.status}. The Hub auth token was rejected — ask the user to log in again.`,
            );
          }
          const errText = (await response.text()).slice(0, 200);
          throw new Error(`Hub categories list failed (HTTP ${response.status}): ${errText || response.statusText}`);
        }

        const data = (await response.json()) as { categories?: unknown };
        const categories = Array.isArray(data.categories)
          ? data.categories.filter((c): c is string => typeof c === "string")
          : [];
        return {
          output: JSON.stringify({ categories }, null, 2),
          metadata: { tool: "hub_world_categories_list", count: categories.length },
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`Hub categories list timed out after ${TIMEOUT_MS}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
