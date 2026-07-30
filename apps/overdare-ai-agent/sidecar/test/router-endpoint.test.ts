// @summary Tests the authenticated endpoint the Rust MCP router calls (P071): bearer enforcement,
// catalog fetch, tool execution, prompt fetch, and that non-router paths are left to the web server.

import { describe, expect, test } from "bun:test";
import type { Tool } from "@diligent/core/tool-contract";
import { z } from "zod";
import type { McpRegistries } from "../src/mcp-server";
import {
  createRouterEndpoint,
  ROUTER_CATALOG_ROUTE,
  ROUTER_PROMPT_GET_ROUTE,
  ROUTER_TOOL_CALL_ROUTE,
  routerRouteMatches,
} from "../src/router-endpoint";

const TOKEN = "a".repeat(64);

function registries(): McpRegistries {
  const echo: Tool = {
    name: "echo",
    description: "Echo the message back.",
    parameters: z.object({ message: z.string() }),
    async execute({ message }) {
      return { output: `echo: ${message}` };
    },
  };
  const failing: Tool = {
    name: "explode",
    description: "Always fails.",
    parameters: z.object({}),
    async execute() {
      throw new Error("boom");
    },
  };
  return {
    tools: new Map([
      [echo.name, echo],
      [failing.name, failing],
    ]),
    prompts: new Map([["agent-x", { name: "agent-x", description: "An agent", load: async () => "AGENT BODY" }]]),
  };
}

function endpoint(token = TOKEN) {
  const built = createRouterEndpoint({ token, registries: async () => registries() });
  return async (path: string, init: RequestInit = {}, bearer: string | null = token): Promise<Response> => {
    const url = new URL(`http://127.0.0.1:7433${path}`);
    const headers = new Headers(init.headers);
    if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
    const request = new Request(url, { ...init, headers });
    expect(built.matches(url)).toBe(true);
    return built.handle(request, url);
  };
}

describe("route matching", () => {
  test("only router paths match, so existing web routes are untouched", () => {
    const url = (path: string) => new URL(`http://127.0.0.1:7433${path}`);
    expect(routerRouteMatches(url(ROUTER_CATALOG_ROUTE))).toBe(true);
    expect(routerRouteMatches(url(ROUTER_TOOL_CALL_ROUTE))).toBe(true);
    expect(routerRouteMatches(url("/mcp-router"))).toBe(true);

    for (const path of ["/rpc", "/health", "/", "/index.html", "/__diligent_images__/x.png"]) {
      expect(routerRouteMatches(url(path))).toBe(false);
    }
    // Prefix-adjacent paths must not be captured — a static asset called /mcp-router-guide.html
    // belongs to the web server.
    expect(routerRouteMatches(url("/mcp-router-guide.html"))).toBe(false);
  });
});

describe("authentication", () => {
  test("a missing Authorization header is rejected", async () => {
    const call = endpoint();
    const response = await call(ROUTER_CATALOG_ROUTE, {}, null);
    expect(response.status).toBe(401);
  });

  test("a wrong token of the same length is rejected", async () => {
    const call = endpoint();
    const response = await call(ROUTER_CATALOG_ROUTE, {}, "b".repeat(64));
    expect(response.status).toBe(401);
  });

  test("a token of a different length is rejected without throwing", async () => {
    // timingSafeEqual throws on length mismatch, so the length check has to come first.
    const call = endpoint();
    expect((await call(ROUTER_CATALOG_ROUTE, {}, "short")).status).toBe(401);
    expect((await call(ROUTER_CATALOG_ROUTE, {}, "")).status).toBe(401);
  });

  test("a non-Bearer scheme is rejected", async () => {
    const built = createRouterEndpoint({ token: TOKEN, registries: async () => registries() });
    const url = new URL(`http://127.0.0.1:7433${ROUTER_CATALOG_ROUTE}`);
    const response = await built.handle(new Request(url, { headers: { authorization: `Basic ${TOKEN}` } }), url);
    expect(response.status).toBe(401);
  });

  test("auth is checked before the route is dispatched", async () => {
    // An unauthenticated caller must not be able to tell a real route from a typo.
    const call = endpoint();
    expect((await call("/mcp-router/nope", {}, null)).status).toBe(401);
  });
});

describe("catalog", () => {
  test("returns the tool and prompt lists in MCP shape", async () => {
    const call = endpoint();
    const response = await call(ROUTER_CATALOG_ROUTE);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo", "explode"]);
    expect(body.tools[0].inputSchema.type).toBe("object");
    expect(body.prompts).toEqual([{ name: "agent-x", description: "An agent" }]);
  });

  test("rejects a non-GET method", async () => {
    const call = endpoint();
    expect((await call(ROUTER_CATALOG_ROUTE, { method: "POST" })).status).toBe(405);
  });
});

describe("tool calls", () => {
  test("executes the named tool and returns its content", async () => {
    const call = endpoint();
    const response = await call(ROUTER_TOOL_CALL_ROUTE, {
      method: "POST",
      body: JSON.stringify({ tool: "echo", args: { message: "hi" }, routerCallId: "call-1" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content).toEqual([{ type: "text", text: "echo: hi" }]);
    expect(body.isError).toBeUndefined();
  });

  test("an unknown tool is a tool error, not an HTTP error", async () => {
    // The router forwards the body to the model; a 4xx would instead read as a dead sidecar and
    // would wrongly clear the active Studio selection.
    const call = endpoint();
    const response = await call(ROUTER_TOOL_CALL_ROUTE, {
      method: "POST",
      body: JSON.stringify({ tool: "nope", args: {}, routerCallId: "c" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.isError).toBe(true);
    expect(body.content[0].text).toContain("Unknown tool: nope");
  });

  test("a throwing tool is reported as a tool error", async () => {
    const call = endpoint();
    const response = await call(ROUTER_TOOL_CALL_ROUTE, {
      method: "POST",
      body: JSON.stringify({ tool: "explode", args: {}, routerCallId: "c" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.isError).toBe(true);
    expect(body.content[0].text).toContain("boom");
  });

  test("invalid arguments are reported as a tool error", async () => {
    const call = endpoint();
    const response = await call(ROUTER_TOOL_CALL_ROUTE, {
      method: "POST",
      body: JSON.stringify({ tool: "echo", args: { message: 42 }, routerCallId: "c" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).isError).toBe(true);
  });

  test("a malformed body and a missing tool name are request errors", async () => {
    const call = endpoint();
    expect((await call(ROUTER_TOOL_CALL_ROUTE, { method: "POST", body: "not json" })).status).toBe(400);
    expect((await call(ROUTER_TOOL_CALL_ROUTE, { method: "POST", body: JSON.stringify({ args: {} }) })).status).toBe(
      400,
    );
  });

  test("rejects a non-POST method", async () => {
    const call = endpoint();
    expect((await call(ROUTER_TOOL_CALL_ROUTE, { method: "GET" })).status).toBe(405);
  });
});

describe("prompts", () => {
  test("returns the prompt body as an MCP message", async () => {
    const call = endpoint();
    const response = await call(ROUTER_PROMPT_GET_ROUTE, {
      method: "POST",
      body: JSON.stringify({ name: "agent-x" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.description).toBe("An agent");
    expect(body.messages).toEqual([{ role: "user", content: { type: "text", text: "AGENT BODY" } }]);
  });

  test("an unknown prompt is a 404", async () => {
    const call = endpoint();
    const response = await call(ROUTER_PROMPT_GET_ROUTE, {
      method: "POST",
      body: JSON.stringify({ name: "nope" }),
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain("Unknown prompt");
  });

  test("a missing name is a request error", async () => {
    const call = endpoint();
    expect((await call(ROUTER_PROMPT_GET_ROUTE, { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
  });
});

describe("unknown router routes", () => {
  test("an authenticated call to an unknown router path is a 404", async () => {
    const call = endpoint();
    const response = await call("/mcp-router/does-not-exist");
    expect(response.status).toBe(404);
  });
});

describe("lazy registries", () => {
  test("registries are only built when a router request arrives", async () => {
    // Building them eagerly would put skill discovery on the sidecar's startup path, which the
    // launcher times out on while waiting for DILIGENT_PORT.
    let builds = 0;
    const built = createRouterEndpoint({
      token: TOKEN,
      registries: async () => {
        builds += 1;
        return registries();
      },
    });
    expect(builds).toBe(0);

    const url = new URL(`http://127.0.0.1:7433${ROUTER_CATALOG_ROUTE}`);
    await built.handle(new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } }), url);
    expect(builds).toBe(1);
  });

  test("an unauthorized request never builds the registries", async () => {
    let builds = 0;
    const built = createRouterEndpoint({
      token: TOKEN,
      registries: async () => {
        builds += 1;
        return registries();
      },
    });
    const url = new URL(`http://127.0.0.1:7433${ROUTER_CATALOG_ROUTE}`);
    await built.handle(new Request(url), url);
    expect(builds).toBe(0);
  });
});
