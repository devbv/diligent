// @summary Tests for McpConnectionManager — signature reuse, dispose, error isolation, call mapping

import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { McpConnectionManager, type McpTransportFactory } from "../../../src/tools/mcp/client";
import type { McpServerConfig } from "../../../src/tools/mcp/types";

function buildServer(name: string): McpServer {
  const server = new McpServer({ name, version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
  );
  return server;
}

function countingFactory(): { factory: McpTransportFactory; connects: () => number; failFor?: Set<string> } {
  let connects = 0;
  const state = { failFor: new Set<string>() };
  const factory: McpTransportFactory = async (name): Promise<Transport> => {
    if (state.failFor.has(name)) throw new Error(`boom:${name}`);
    connects += 1;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await buildServer(name).connect(serverTransport);
    return clientTransport;
  };
  return Object.assign({ factory, connects: () => connects }, state);
}

const stdioConfig: McpServerConfig = { command: "irrelevant", args: [] };

describe("McpConnectionManager.sync", () => {
  test("connects once and lists tools", async () => {
    const f = countingFactory();
    const manager = new McpConnectionManager(f.factory);
    const runtimes = await manager.sync({ github: stdioConfig });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]).toMatchObject({ name: "github", status: "connected" });
    expect(runtimes[0].tools.map((t) => t.name)).toContain("echo");
    expect(runtimes[0].tools[0].readOnly).toBe(true);
    await manager.disposeAll();
  });

  test("reuses connection on identical signature", async () => {
    const f = countingFactory();
    const manager = new McpConnectionManager(f.factory);
    await manager.sync({ github: stdioConfig });
    await manager.sync({ github: stdioConfig });
    expect(f.connects()).toBe(1);
    await manager.disposeAll();
  });

  test("reconnects when transport signature changes", async () => {
    const f = countingFactory();
    const manager = new McpConnectionManager(f.factory);
    await manager.sync({ github: stdioConfig });
    await manager.sync({ github: { command: "irrelevant", args: ["--changed"] } });
    expect(f.connects()).toBe(2);
    await manager.disposeAll();
  });

  test("isolates a failing server without affecting others", async () => {
    const f = countingFactory();
    f.failFor.add("bad");
    const manager = new McpConnectionManager(f.factory);
    const runtimes = await manager.sync({ bad: stdioConfig, good: stdioConfig });
    const bad = runtimes.find((r) => r.name === "bad");
    const good = runtimes.find((r) => r.name === "good");
    expect(bad?.status).toBe("error");
    expect(bad?.error).toContain("boom:bad");
    expect(good?.status).toBe("connected");
    await manager.disposeAll();
  });

  test("coalesces concurrent syncs into a single connect (no double OAuth/login)", async () => {
    let connects = 0;
    const slowFactory: McpTransportFactory = async (name): Promise<Transport> => {
      connects += 1;
      await new Promise((r) => setTimeout(r, 30));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await buildServer(name).connect(serverTransport);
      return clientTransport;
    };
    const manager = new McpConnectionManager(slowFactory);
    const [a, b] = await Promise.all([manager.sync({ github: stdioConfig }), manager.sync({ github: stdioConfig })]);
    expect(connects).toBe(1);
    expect(a[0].status).toBe("connected");
    expect(b[0].status).toBe("connected");
    await manager.disposeAll();
  });

  test("disposes a removed server", async () => {
    const f = countingFactory();
    const manager = new McpConnectionManager(f.factory);
    await manager.sync({ github: stdioConfig });
    const runtimes = await manager.sync({});
    expect(runtimes).toHaveLength(0);
    // Re-adding reconnects (proves the old one was disposed, not reused).
    await manager.sync({ github: stdioConfig });
    expect(f.connects()).toBe(2);
    await manager.disposeAll();
  });
});

describe("McpConnectionManager.call", () => {
  test("routes a call and normalizes the result", async () => {
    const f = countingFactory();
    const manager = new McpConnectionManager(f.factory);
    await manager.sync({ github: stdioConfig });
    const result = await manager.call("github", "echo", { text: "hi" }, new AbortController().signal);
    expect(result.text).toBe("echo:hi");
    expect(result.isError).toBe(false);
    await manager.disposeAll();
  });

  test("throws when the server is not connected", async () => {
    const manager = new McpConnectionManager(countingFactory().factory);
    await expect(manager.call("nope", "echo", {}, new AbortController().signal)).rejects.toThrow(/not connected/);
  });
});
