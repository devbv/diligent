// @summary Tests the OVERDARE MCP server: studio tools exposed as MCP tools and bootstrap
// skills/agents/system-prompt exposed as MCP prompts, via an in-memory MCP client.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const levelBrowseMock = mock(async () => [
  { guid: "WORKSPACE_GUID", name: "Workspace", class: "Folder", children: [] },
]);

mock.module("../src/tools/studiorpc/rpc.ts", () => ({
  applyLevelChanges: async () => ({ ok: true }),
  call: (method: string) => {
    if (method === "level.browse") return levelBrowseMock();
    throw new Error(`Unexpected RPC method in test: ${method}`);
  },
}));

const { buildRegistries, createMcpServer } = await import("../src/mcp-server");

async function makeBootstrapDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overdare-mcp-"));
  await writeFile(join(dir, "system-prompt.txt"), "SYSTEM PROMPT BODY", "utf-8");

  const skillDir = join(dir, "skills", "test-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: test-skill\ndescription: A test skill\n---\nSKILL BODY CONTENT",
    "utf-8",
  );

  const agentDir = join(dir, "agents", "test-agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "AGENT.md"),
    "---\nname: test-agent\ndescription: A test agent\nmodel_class: lite\n---\nAGENT BODY CONTENT",
    "utf-8",
  );

  return dir;
}

async function connectClient(bootstrapDir: string): Promise<Client> {
  const registries = await buildRegistries({ cwd: process.cwd(), bootstrapDir });
  const server = createMcpServer(registries);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("OVERDARE MCP server", () => {
  beforeEach(() => {
    levelBrowseMock.mockClear();
  });

  test("lists studio built-in tools with input schemas", async () => {
    const client = await connectClient(await makeBootstrapDir());
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("studiorpc_level_browse");
    expect(names).toContain("validatelua");
    expect(names).toContain("overdaresearch");
    expect(names).toContain("overdaresearch_deep");
    const browse = tools.find((tool) => tool.name === "studiorpc_level_browse");
    expect(browse?.inputSchema).toBeDefined();
    expect(browse?.inputSchema).not.toHaveProperty("$schema");
    await client.close();
  });

  test("calls a studio tool and returns its output", async () => {
    const client = await connectClient(await makeBootstrapDir());
    const result = await client.callTool({ name: "studiorpc_level_browse", arguments: {} });
    expect(levelBrowseMock).toHaveBeenCalledTimes(1);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("Workspace");
    await client.close();
  });

  test("reports unknown tool as an error", async () => {
    const client = await connectClient(await makeBootstrapDir());
    const result = await client.callTool({ name: "does_not_exist", arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });

  test("surfaces instructions telling the client to read overdare-system-prompt first", async () => {
    const client = await connectClient(await makeBootstrapDir());
    const instructions = client.getInstructions();
    expect(instructions).toContain("overdare-system-prompt");
    expect(instructions).toContain(".uasset");
    await client.close();
  });

  test("exposes bootstrap skills, agents, and the system prompt as prompts", async () => {
    const client = await connectClient(await makeBootstrapDir());
    const { prompts } = await client.listPrompts();
    const names = prompts.map((prompt) => prompt.name);
    expect(names).toContain("overdare-system-prompt");
    expect(names).toContain("test-skill");
    expect(names).toContain("agent-test-agent");
    await client.close();
  });

  test("returns skill body via getPrompt", async () => {
    const client = await connectClient(await makeBootstrapDir());
    const result = await client.getPrompt({ name: "test-skill" });
    const message = result.messages[0];
    expect(message?.role).toBe("user");
    expect((message?.content as { text?: string })?.text).toContain("SKILL BODY CONTENT");
    await client.close();
  });

  test("returns system prompt via getPrompt", async () => {
    const client = await connectClient(await makeBootstrapDir());
    const result = await client.getPrompt({ name: "overdare-system-prompt" });
    expect((result.messages[0]?.content as { text?: string })?.text).toBe("SYSTEM PROMPT BODY");
    await client.close();
  });
});
