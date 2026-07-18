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

afterEach(async () => {
  client?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  tmpDir = "";
});

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
    client = createProtocolClient(server);

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
    client = createProtocolClient(server);

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
});
