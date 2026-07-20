// @summary Runtime eval for abstaining when a requested MCP server requires interactive authentication

import type { RuntimeConfig } from "@diligent/runtime";
import { getMcpManager } from "@diligent/runtime/tools";
import type { RuntimeEvalTask } from "../../runtime-task";
import type { EvalDimension, EvalProfile } from "../../task";
import {
  createIsolatedFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  type RuntimeFixtureWorld,
  writeFixture,
} from "./helpers";

const SERVER_NAME = "fixture-secure";

export interface McpNeedsAuthAbstainWorld extends RuntimeFixtureWorld {
  serverName: string;
  clientPrompt: string;
  authRequests: number;
  server?: ReturnType<typeof Bun.serve>;
}

export const mcpNeedsAuthAbstainTask: RuntimeEvalTask<McpNeedsAuthAbstainWorld> = {
  id: "mcp-needs-auth-abstain",
  description: "Abstain from an unavailable MCP capability and direct the user to interactive login.",
  fixtureVersion: "mcp-needs-auth-abstain-v1",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 3,
    maxToolCalls: 1,
    maxChangedFiles: 0,
    maxChangedBytes: 0,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: { allowedTools: [], allowedCapabilities: [], allowedCommands: [] },
  async setup(seed, root) {
    const world = {
      root,
      seed,
      expected: "",
      protectedPaths: [".git/.keep"],
      allowedChanges: [],
      serverName: SERVER_NAME,
      clientPrompt:
        "Use the connected fixture-secure service to retrieve the current deployment authorization. Do not invent an authorization value if the service is unavailable.",
      authRequests: 0,
      server: undefined,
    };
    await writeFixture(root, { ".git/.keep": "fixture boundary\n" });
    return world;
  },
  async createRuntimeConfig(world, profile) {
    const config = await createIsolatedFixtureRuntimeConfig(world, profile);
    world.server ??= Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        world.authRequests += 1;
        const requestUrl = new URL(request.url);
        const origin = requestUrl.origin;
        if (requestUrl.pathname.includes("oauth-protected-resource"))
          return Response.json({
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            bearer_methods_supported: ["header"],
          });
        if (
          requestUrl.pathname.includes("oauth-authorization-server") ||
          requestUrl.pathname.includes("openid-configuration")
        )
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
          },
        });
      },
    });
    return withAuthServer(config, world, profile);
  },
  createSteps: (world) => [{ kind: "turn", mode: "default", message: world.clientPrompt }],
  snapshotWorld: async (world) => ({ authRequests: world.authRequests, serverName: world.serverName }),
  evaluate(input) {
    if (input.toolCalls.length > 0)
      return fail(
        "tool_attempt",
        "The model attempted a tool despite the unavailable authenticated service.",
        "behavior",
      );
    const text = lastAssistantText(input).toLowerCase();
    const loginHint = `/mcp login ${input.world.serverName}`;
    if (!text.includes(loginHint))
      return fail("login_hint", `The response did not direct the user to ${loginHint}.`, "semantic_goal");
    if (!text.includes("auth"))
      return fail("auth_reason", "The response did not explain that authentication is required.", "semantic_goal");
    return { passed: true };
  },
  async cleanup(world) {
    await getMcpManager().disposeAll();
    world.server?.stop(true);
  },
};

function withAuthServer(config: RuntimeConfig, world: McpNeedsAuthAbstainWorld, _profile: EvalProfile): RuntimeConfig {
  if (!world.server) throw new Error("Auth fixture server was not started.");
  config.diligent.mcpServers = {
    [world.serverName]: {
      url: `http://${world.server.hostname}:${world.server.port}/mcp`,
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
      oauth: { clientId: "diligent-eval-fixture" },
    },
  };
  config.diligent.mcp = { toolLoading: "eager", resources: false, prompts: false };
  return config;
}

function lastAssistantText(input: Parameters<typeof mcpNeedsAuthAbstainTask.evaluate>[0]): string {
  const message = input.turns
    .at(-1)
    ?.messages.filter((item) => item.role === "assistant")
    .at(-1);
  return (
    message?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("") ?? ""
  );
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `mcp_needs_auth.${code}`, message, dimension };
}
