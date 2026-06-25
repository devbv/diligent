// @summary Tests for web app action helpers that decide which composer input state to clear on send and first-thread setup

import { expect, mock, test } from "bun:test";
import type { Mode } from "@diligent/protocol";
import { prependContextToMessage } from "../../../src/client/lib/agent-native-bridge";
import type { PendingImage } from "../../../src/client/lib/app-state";
import {
  clearComposerInputAfterSend,
  getModelChangeThreadId,
  normalizeUploadedImageAttachment,
  prepareNewThreadForFirstMessage,
  runThreadCompaction,
  waitForDelayedIndicator,
} from "../../../src/client/lib/use-app-actions";
import { WEB_IMAGE_ROUTE_PREFIX } from "../../../src/shared/image-routes";

test("clearComposerInputAfterSend clears draft input when sending first message from new conversation", () => {
  const clearThreadInput = mock(() => {});
  const clearDraftInput = mock(() => {});

  clearComposerInputAfterSend({
    activeThreadId: null,
    clearThreadInput,
    clearDraftInput,
    clearContextItems: mock(() => {}),
  });

  expect(clearDraftInput).toHaveBeenCalledTimes(1);
  expect(clearThreadInput).not.toHaveBeenCalled();
});

test("clearComposerInputAfterSend clears active thread input for existing conversations", () => {
  const clearThreadInput = mock(() => {});
  const clearDraftInput = mock(() => {});
  const clearContextItems = mock(() => {});

  clearComposerInputAfterSend({
    activeThreadId: "thread-1",
    clearThreadInput,
    clearDraftInput,
    clearContextItems,
  });

  expect(clearThreadInput).toHaveBeenCalledWith("thread-1");
  expect(clearDraftInput).not.toHaveBeenCalled();
  expect(clearContextItems).toHaveBeenCalledTimes(1);
});

test("prependContextToMessage serializes mixed context items before typed text", () => {
  const result = prependContextToMessage("adjust these", [
    {
      kind: "instance",
      source: "studiorpc",
      GUID: "guid-1",
      ClassType: "Part",
      Name: "Spawn_A",
    },
    {
      kind: "file",
      source: "vscode",
      uri: "file:///workspace/spawn.ts",
      Name: "spawn.ts",
      languageId: "typescript",
    },
  ]);

  expect(result).toContain("<AttachedContext>");
  expect(result).toContain("</AttachedContext>");
  expect(result).toContain("Instance: Name=Spawn_A; ClassType=Part; GUID=guid-1");
  expect(result).toContain("File: Name=spawn.ts; URI=file:///workspace/spawn.ts; Language=typescript");
  expect(result.endsWith("adjust these")).toBe(true);
});

test("getModelChangeThreadId scopes model changes to the active thread when present", () => {
  expect(getModelChangeThreadId("thread-1")).toBe("thread-1");
  expect(getModelChangeThreadId(null)).toBeUndefined();
});

test("normalizeUploadedImageAttachment keeps canonical webUrl from image/upload", () => {
  expect(
    normalizeUploadedImageAttachment({
      type: "local_image",
      path: "/repo/.diligent/images/thread-1/shot.png",
      mediaType: "image/png",
      fileName: "shot.png",
      webUrl: `${WEB_IMAGE_ROUTE_PREFIX}thread-1/shot.png`,
    }),
  ).toEqual({
    type: "local_image",
    path: "/repo/.diligent/images/thread-1/shot.png",
    mediaType: "image/png",
    fileName: "shot.png",
    webUrl: `${WEB_IMAGE_ROUTE_PREFIX}thread-1/shot.png`,
  });
});

test("normalizeUploadedImageAttachment derives webUrl for persisted legacy image/upload responses", () => {
  expect(
    normalizeUploadedImageAttachment({
      type: "local_image",
      path: "/repo/.diligent/images/drafts/floor.png",
      mediaType: "image/png",
      fileName: "floor.png",
    }),
  ).toEqual({
    type: "local_image",
    path: "/repo/.diligent/images/drafts/floor.png",
    mediaType: "image/png",
    fileName: "floor.png",
    webUrl: `${WEB_IMAGE_ROUTE_PREFIX}drafts/floor.png`,
  });
});

test("normalizeUploadedImageAttachment rejects non-web-addressable image/upload responses", () => {
  expect(() =>
    normalizeUploadedImageAttachment({
      type: "local_image",
      path: "/tmp/floor.png",
      mediaType: "image/png",
      fileName: "floor.png",
    }),
  ).toThrow("browser-accessible URL");
});

test("waitForDelayedIndicator skips the indicator for quick tasks", async () => {
  let shown = 0;

  const result = await waitForDelayedIndicator({
    task: Promise.resolve("uploaded"),
    delayMs: 20,
    showIndicator: () => {
      shown += 1;
    },
  });

  expect(result).toBe("uploaded");
  expect(shown).toBe(0);
});

test("waitForDelayedIndicator shows the indicator for slower tasks", async () => {
  let shown = 0;
  let finish!: (value: string) => void;
  const task = new Promise<string>((resolve) => {
    finish = resolve;
  });

  const resultPromise = waitForDelayedIndicator({
    task,
    delayMs: 1,
    showIndicator: () => {
      shown += 1;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(shown).toBe(1);
  finish("uploaded");
  expect(await resultPromise).toBe("uploaded");
});

test("mock bridge update semantics replace prior context with latest snapshot", async () => {
  const { createAgentNativeBridge } = await import("../../../src/client/lib/agent-native-bridge");

  let latestItems: unknown[] = [];
  const bridge = createAgentNativeBridge({
    updateContextItems(items) {
      latestItems = items;
    },
  });

  bridge.updateContextItems([
    {
      GUID: "guid-1",
      ClassType: "Part",
      Name: "Spawn_A",
    },
  ]);
  expect(latestItems).toHaveLength(1);

  bridge.updateContextItems([
    {
      uri: "file:///workspace/next.ts",
      Name: "next.ts",
    },
  ]);
  expect(latestItems).toEqual([
    {
      kind: "file",
      source: "vscode",
      uri: "file:///workspace/next.ts",
      Name: "next.ts",
    },
  ]);
});

test("prepareNewThreadForFirstMessage subscribes and hydrates before starting optimistic first message flow", async () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: {
      location: { pathname: "/" },
      history: { replaceState: mock(() => {}) },
    },
    configurable: true,
    writable: true,
  });

  const request = mock(async (method: string, params: unknown) => {
    if (method === "thread/start") {
      expect(params).toEqual({ cwd: "/repo", mode: "default", effort: "high", model: "gpt-5" });
      return { threadId: "thread-1" };
    }
    throw new Error(`unexpected method: ${method} ${JSON.stringify(params)}`);
  });
  const rpc = { request } as never;
  const history = {
    cwd: "/repo",
    items: [],
    entryCount: 0,
    isRunning: true,
    currentEffort: "medium",
    currentModel: "gpt-5",
  };
  const activateServerThread = mock(async (threadId: string) => {
    expect(threadId).toBe("thread-1");
    return history;
  });
  const applySessionModel = mock(async () => {});
  const dispatch = mock(() => {});
  const images: PendingImage[] = [];

  try {
    const result = await prepareNewThreadForFirstMessage({
      rpc,
      mode: "default",
      cwd: "/repo",
      model: "gpt-5",
      effort: "high",
      activateServerThread,
      applySessionModel,
      dispatch,
      localText: "hello",
      contextItems: [],
      message: "hello",
      images,
    });

    expect(result).toEqual({ threadId: "thread-1", history });
    expect(request.mock.calls.map((call) => call[0])).toEqual(["thread/start"]);
    expect(activateServerThread).toHaveBeenCalledWith("thread-1");
    expect(dispatch.mock.calls).toEqual([
      [{ type: "hydrate", payload: { threadId: "thread-1", mode: "default", history } }],
      [{ type: "local_user", payload: { text: "hello", images, contextItems: [] } }],
    ]);
    expect(applySessionModel).toHaveBeenCalledWith("gpt-5");
  } finally {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    } else {
      delete (globalThis as { window?: Window }).window;
    }
  }
});

test("prepareNewThreadForFirstMessage passes medium effort through thread start without extra effort request", async () => {
  const request = mock(async (method: string, params: unknown) => {
    if (method === "thread/start") {
      expect(params).toEqual({ cwd: "/repo", mode: "default", effort: "medium", model: "gpt-5" });
      return { threadId: "thread-2" };
    }
    throw new Error(`unexpected method: ${method} ${JSON.stringify(params)}`);
  });
  const rpc = { request } as never;
  const history = {
    cwd: "/repo",
    items: [],
    entryCount: 0,
    isRunning: false,
    currentEffort: "medium",
    currentModel: "gpt-5",
  };
  const activateServerThread = mock(async () => history);
  const applySessionModel = mock(async () => {});
  const dispatch = mock(() => {});

  const result = await prepareNewThreadForFirstMessage({
    rpc,
    mode: "default",
    cwd: "/repo",
    model: "gpt-5",
    effort: "medium",
    activateServerThread,
    applySessionModel,
    dispatch,
    message: "hello",
    localText: "hello",
    contextItems: [],
    images: [],
  });

  expect(result).toEqual({ threadId: "thread-2", history });
  expect(request.mock.calls.map((call) => call[0])).toEqual(["thread/start"]);
});

test("turn/steer request schema accepts image attachments", async () => {
  const { DiligentClientRequestSchema } = await import("@diligent/protocol");

  expect(
    DiligentClientRequestSchema.safeParse({
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        content: "check this image",
        attachments: [{ type: "local_image", path: "/tmp/shot.png", mediaType: "image/png", fileName: "shot.png" }],
        followUp: false,
      },
    }).success,
  ).toBe(true);
});

test("runThreadCompaction waits without client RPC timeout and hydrates after success", async () => {
  const request = mock(async (method: string, params: unknown, timeoutMs?: number) => {
    if (method === "thread/compact/start") {
      expect(params).toEqual({ threadId: "thread-1" });
      expect(timeoutMs).toBeNull();
      return { compacted: true };
    }
    if (method === "thread/read") {
      expect(params).toEqual({ threadId: "thread-1" });
      return {
        cwd: "/repo",
        items: [],
        entryCount: 1,
        isRunning: false,
        currentEffort: "medium",
        currentModel: "gpt-5",
      };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const dispatch = mock(() => {});
  const rpc = { request } as never;

  await runThreadCompaction({
    rpc,
    threadId: "thread-1",
    mode: "default" as Mode,
    dispatch,
  });

  expect(request.mock.calls.map((call) => call[0])).toEqual(["thread/compact/start", "thread/read"]);
  expect(dispatch.mock.calls).toEqual([
    [
      {
        type: "hydrate",
        payload: {
          threadId: "thread-1",
          mode: "default",
          history: {
            cwd: "/repo",
            items: [],
            entryCount: 1,
            isRunning: false,
            currentEffort: "medium",
            currentModel: "gpt-5",
          },
        },
      },
    ],
  ]);
});

test("runThreadCompaction surfaces compaction request errors and clears compacting state", async () => {
  const request = mock(async () => {
    throw new Error("RPC timeout for thread/compact/start");
  });
  const dispatch = mock(() => {});
  const rpc = { request } as never;

  await runThreadCompaction({
    rpc,
    threadId: "thread-1",
    mode: "default" as Mode,
    dispatch,
  });

  expect(dispatch.mock.calls).toEqual([
    [
      {
        type: "compaction_error",
      },
    ],
    [
      {
        type: "show_info_toast",
        payload: "RPC timeout for thread/compact/start",
      },
    ],
  ]);
});
