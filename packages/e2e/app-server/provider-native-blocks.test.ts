// @summary App-server e2e tests for provider-native block streaming and persistence
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import { createProviderNativeWebStream } from "./helpers/fake-stream";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

let tmpDir: string;
let client: ProtocolTestClient;

async function setup(streamFunction?: ReturnType<typeof createProviderNativeWebStream>) {
  tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-provider-native-"));
  const server = createTestServer({
    cwd: tmpDir,
    streamFunction: streamFunction ?? createProviderNativeWebStream("done"),
  });
  client = createProtocolClient(server);
}

afterEach(async () => {
  client?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("provider-native-blocks", () => {
  test("provider_tool_use block arrives as message_delta content_block_delta event during streaming", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    const turnNotifs = await client.sendTurnAndWait(threadId, "search the web");

    const messageDeltaEvents = turnNotifs.filter(
      (n) =>
        n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
        (n.params as { event?: { type?: string } }).event?.type === "message_delta",
    );

    const providerToolUseDelta = messageDeltaEvents.find((n) => {
      const event = (n.params as { event?: { delta?: { type?: string; block?: { type?: string } } } }).event;
      return event?.delta?.type === "content_block_delta" && event.delta.block?.type === "provider_tool_use";
    });

    expect(providerToolUseDelta).toBeTruthy();
  });

  test("web_search_result block arrives as message_delta content_block_delta event during streaming", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    const turnNotifs = await client.sendTurnAndWait(threadId, "search the web");

    const messageDeltaEvents = turnNotifs.filter(
      (n) =>
        n.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
        (n.params as { event?: { type?: string } }).event?.type === "message_delta",
    );

    const webSearchResultDelta = messageDeltaEvents.find((n) => {
      const event = (n.params as { event?: { delta?: { type?: string; block?: { type?: string } } } }).event;
      return event?.delta?.type === "content_block_delta" && event.delta.block?.type === "web_search_result";
    });

    expect(webSearchResultDelta).toBeTruthy();
  });

  test("provider-native blocks are persisted and readable via thread/read", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    await client.sendTurnAndWait(threadId, "search the web");

    const result = (await client.request("thread/read", { threadId })) as {
      items: Array<{
        type: string;
        message?: { content?: Array<{ type: string }> };
      }>;
    };

    const agentMessage = result.items.find((item) => item.type === "agentMessage");
    expect(agentMessage).toBeTruthy();

    const content = agentMessage?.message?.content ?? [];
    const contentTypes = content.map((b) => b.type);

    expect(contentTypes).toContain("provider_tool_use");
    expect(contentTypes).toContain("web_search_result");
    expect(contentTypes).toContain("web_fetch_result");
    expect(contentTypes).toContain("text");
  });

  test("provider_tool_use block has correct fields in persisted message", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    await client.sendTurnAndWait(threadId, "search the web");

    const result = (await client.request("thread/read", { threadId })) as {
      items: Array<{
        type: string;
        message?: {
          content?: Array<{
            type: string;
            id?: string;
            provider?: string;
            name?: string;
            input?: Record<string, unknown>;
          }>;
        };
      }>;
    };

    const agentMessage = result.items.find((item) => item.type === "agentMessage");
    const providerBlock = agentMessage?.message?.content?.find((b) => b.type === "provider_tool_use");

    expect(providerBlock).toBeTruthy();
    expect(providerBlock?.id).toBe("ptu-1");
    expect(providerBlock?.provider).toBe("anthropic");
    expect(providerBlock?.name).toBe("web_search");
  });

  test("web_search_result block has correct fields in persisted message", async () => {
    await setup();
    const threadId = await client.initAndStartThread(tmpDir);

    await client.sendTurnAndWait(threadId, "search the web");

    const result = (await client.request("thread/read", { threadId })) as {
      items: Array<{
        type: string;
        message?: {
          content?: Array<{
            type: string;
            toolUseId?: string;
            results?: Array<{ url: string; title?: string }>;
          }>;
        };
      }>;
    };

    const agentMessage = result.items.find((item) => item.type === "agentMessage");
    const searchBlock = agentMessage?.message?.content?.find((b) => b.type === "web_search_result");

    expect(searchBlock).toBeTruthy();
    expect(searchBlock?.toolUseId).toBe("ptu-1");
    expect(searchBlock?.results).toHaveLength(1);
    expect(searchBlock?.results?.[0]?.url).toBe("https://example.com");
  });
});
