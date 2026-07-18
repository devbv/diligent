// @summary App-server e2e tests for approval and user-input server request round trips

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  DILIGENT_SERVER_REQUEST_METHODS,
  type DiligentServerRequest,
} from "@diligent/protocol";
import { createPermissionEngine } from "@diligent/runtime";
import { createToolUseStream } from "./helpers/fake-stream";
import { createProtocolClient, type ProtocolTestClient } from "./helpers/protocol-client";
import { createTestServer } from "./helpers/server-factory";

type ApprovalServerRequest = Extract<
  DiligentServerRequest,
  { method: typeof DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST }
>;
type UserInputServerRequest = Extract<
  DiligentServerRequest,
  { method: typeof DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST }
>;

let tmpDir = "";
let client: ProtocolTestClient;
const clients: ProtocolTestClient[] = [];

afterEach(async () => {
  for (const connectedClient of clients.splice(0)) connectedClient.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  tmpDir = "";
});

function trackClient(server: Parameters<typeof createProtocolClient>[0]): ProtocolTestClient {
  const connectedClient = createProtocolClient(server);
  clients.push(connectedClient);
  return connectedClient;
}

describe("server requests", () => {
  test("approval request round trip allows the tool and resolves the server request", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-approval-"));
    const server = createTestServer({
      cwd: tmpDir,
      runtimeToolsConfig: { builtin: { bash: true } },
      runtimeConfigOverrides: { permissionEngine: createPermissionEngine([]) },
      streamFunction: createToolUseStream(
        [
          {
            id: "tc-approval",
            name: "bash",
            input: { command: "printf approval-ok", description: "Print an approval marker" },
          },
        ],
        "approval complete",
      ),
    });
    client = trackClient(server);

    let approvalRequest: ApprovalServerRequest | undefined;
    client.onServerRequest(async (request) => {
      if (request.method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST) {
        approvalRequest = request;
        return {
          method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
          result: { decision: "once" },
        };
      }
      return {
        method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
        result: { answers: {} },
      };
    });

    const threadId = await client.initAndStartThread(tmpDir);
    const notifications = await client.sendTurnAndWait(threadId, "run the approved command");

    expect(approvalRequest?.params).toMatchObject({
      threadId,
      request: {
        permission: "execute",
        toolName: "bash",
        details: { command: "printf approval-ok" },
      },
    });
    expect(
      notifications.some(
        (notification) => notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
      ),
    ).toBe(true);
    expect(
      notifications.some(
        (notification) =>
          notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
          (notification.params as { event?: { type?: string; output?: string } }).event?.type === "tool_end" &&
          ((notification.params as { event?: { type?: string; output?: string } }).event?.output ?? "").includes(
            "approval-ok",
          ),
      ),
    ).toBe(true);
  });

  test("user-input request round trip returns the answer to the tool and persists its result", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-user-input-"));
    const question = {
      id: "scope",
      header: "scope",
      question: "Which scope should be used?",
      options: [
        { label: "Local", description: "Limit the change to this project." },
        { label: "Global", description: "Apply the change across projects." },
      ],
    };
    const server = createTestServer({
      cwd: tmpDir,
      runtimeToolsConfig: { builtin: { request_user_input: true } },
      streamFunction: createToolUseStream(
        [{ id: "tc-user-input", name: "request_user_input", input: { questions: [question] } }],
        "input received",
      ),
    });
    client = trackClient(server);

    let userInputRequest: UserInputServerRequest | undefined;
    client.onServerRequest(async (request) => {
      if (request.method === DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST) {
        userInputRequest = request;
        return {
          method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
          result: { answers: { scope: "Local" } },
        };
      }
      return {
        method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
        result: { decision: "once" },
      };
    });

    const threadId = await client.initAndStartThread(tmpDir);
    const notifications = await client.sendTurnAndWait(threadId, "ask me for scope");

    expect(userInputRequest?.params).toEqual({
      threadId,
      request: { questions: [question] },
    });
    expect(
      notifications.some(
        (notification) => notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
      ),
    ).toBe(true);

    const readResult = (await client.request("thread/read", { threadId })) as {
      items: Array<{ type: string; toolName?: string; output?: string }>;
    };
    expect(
      readResult.items.some(
        (item) =>
          item.type === "toolCall" &&
          item.toolName === "request_user_input" &&
          (item.output ?? "").includes("Answer: Local"),
      ),
    ).toBe(true);
  });

  test("a user-input request survives disconnect and is answered by a reconnected subscriber", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-e2e-user-input-reconnect-"));
    const question = {
      id: "scope",
      header: "scope",
      question: "Which scope should be used?",
      options: [
        { label: "Local", description: "Limit the change to this project." },
        { label: "Global", description: "Apply the change across projects." },
      ],
    };
    const server = createTestServer({
      cwd: tmpDir,
      runtimeToolsConfig: { builtin: { request_user_input: true } },
      streamFunction: createToolUseStream(
        [{ id: "tc-user-input-reconnect", name: "request_user_input", input: { questions: [question] } }],
        "input received after reconnect",
      ),
    });

    const firstClient = trackClient(server);
    let resolveFirstRequest!: (request: UserInputServerRequest) => void;
    const firstRequestReceived = new Promise<UserInputServerRequest>((resolve) => {
      resolveFirstRequest = resolve;
    });
    firstClient.onServerRequest(async (request) => {
      if (request.method === DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST) {
        resolveFirstRequest(request);
        return await new Promise<never>(() => {});
      }
      return {
        method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
        result: { decision: "once" },
      };
    });

    const threadId = await firstClient.initAndStartThread(tmpDir);
    await firstClient.request("thread/subscribe", { threadId });
    await firstClient.request("turn/start", { threadId, message: "ask me for scope" });
    const initialRequest = await firstRequestReceived;
    expect(initialRequest.params).toEqual({ threadId, request: { questions: [question] } });
    firstClient.simulateClose();

    const reconnectedClient = trackClient(server);
    let redeliveredRequest: UserInputServerRequest | undefined;
    reconnectedClient.onServerRequest(async (request) => {
      if (request.method === DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST) {
        redeliveredRequest = request;
        return {
          method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
          result: { answers: { scope: "Global" } },
        };
      }
      return {
        method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
        result: { decision: "once" },
      };
    });
    await reconnectedClient.request("initialize", {
      clientName: "reconnected-test",
      clientVersion: "0.0.1",
      protocolVersion: 1,
    });
    await reconnectedClient.request("thread/subscribe", { threadId });
    await reconnectedClient.waitFor(
      (notification) =>
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED &&
        (notification.params as { threadId?: string }).threadId === threadId,
    );

    expect(redeliveredRequest?.params).toEqual(initialRequest.params);
    expect(
      reconnectedClient.notifications.some(
        (notification) => notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
      ),
    ).toBe(true);
    const readResult = (await reconnectedClient.request("thread/read", { threadId })) as {
      items: Array<{ type: string; toolName?: string; output?: string }>;
    };
    expect(
      readResult.items.some(
        (item) =>
          item.type === "toolCall" &&
          item.toolName === "request_user_input" &&
          (item.output ?? "").includes("Answer: Global"),
      ),
    ).toBe(true);
  });
});
