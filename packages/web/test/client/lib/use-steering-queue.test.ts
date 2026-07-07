// @summary Tests for steering queue helper functions covering steer RPC, abort-restart, and image attachments
import { describe, expect, mock, test } from "bun:test";
import {
  executeCancelSteer,
  executeRestartFromAbort,
  executeSteer,
  executeUpdateSteer,
} from "../../../src/client/lib/use-steering-queue";

function makeRpc(handler: (method: string, params: unknown) => unknown) {
  return { request: mock(handler) } as never;
}

describe("executeSteer", () => {
  test("dispatches local_steer before RPC resolves and sends the same steer id", async () => {
    const dispatched: unknown[] = [];
    let resolveRequest!: (value: { steerId: string }) => void;
    const rpc = makeRpc(
      () =>
        new Promise<{ steerId: string }>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const pending = executeSteer({
      rpc,
      threadId: "thread-1",
      content: "hello world",
      contextItems: [],
      images: [],
      dispatch: (action) => dispatched.push(action),
      clearThreadInput: mock(() => {}),
      clearPendingImages: mock(() => {}),
      clearContextItems: mock(() => {}),
    });

    expect(dispatched).toHaveLength(1);
    const action = dispatched[0] as { type: "local_steer"; payload: { id: string; content: string } };
    expect(action.type).toBe("local_steer");
    expect(action.payload.content).toBe("hello world");
    expect(rpc.request).toHaveBeenCalledTimes(1);
    const [method, params] = (rpc.request as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      { steerId: string; content: string; followUp: boolean },
    ];
    expect(method).toBe("turn/steer");
    expect(params.steerId).toBe(action.payload.id);
    expect(params.content).toBe("hello world");
    expect(params.followUp).toBe(false);
    resolveRequest({ steerId: action.payload.id });
    await pending;
  });

  test("clears thread input, pending images, and context items before dispatching", async () => {
    const clearThreadInput = mock((_threadId: string) => {});
    const clearPendingImages = mock(() => {});
    const clearContextItems = mock(() => {});
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({ steerId: "s1" }));

    await executeSteer({
      rpc,
      threadId: "thread-abc",
      content: "test",
      contextItems: [],
      images: [],
      dispatch: (action) => dispatched.push(action),
      clearThreadInput,
      clearPendingImages,
      clearContextItems,
    });

    expect(clearThreadInput).toHaveBeenCalledWith("thread-abc");
    expect(clearPendingImages).toHaveBeenCalledTimes(1);
    expect(clearContextItems).toHaveBeenCalledTimes(1);
    expect(dispatched[0]).toMatchObject({ type: "local_steer", payload: { content: "test" } });
  });

  test("prepends attached context items to steer content and clears them", async () => {
    const clearContextItems = mock(() => {});
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({ steerId: "s1" }));

    await executeSteer({
      rpc,
      threadId: "thread-1",
      content: "move it up",
      contextItems: [{ kind: "instance", source: "studiorpc", GUID: "guid-1", ClassType: "Part", Name: "Cube" }],
      images: [],
      dispatch: (action) => dispatched.push(action),
      clearThreadInput: mock(() => {}),
      clearPendingImages: mock(() => {}),
      clearContextItems,
    });

    const expectedContent = [
      "<AttachedContext>",
      "- Instance: Name=Cube; ClassType=Part; GUID=guid-1",
      "</AttachedContext>",
      "move it up",
    ].join("\n");
    const [, params] = (rpc.request as ReturnType<typeof mock>).mock.calls[0] as [string, { content: string }];
    expect(params.content).toBe(expectedContent);
    expect(dispatched[0]).toMatchObject({ type: "local_steer", payload: { content: expectedContent } });
    expect(clearContextItems).toHaveBeenCalledTimes(1);
  });

  test("uses a UUID v4 fallback when crypto.randomUUID is unavailable", async () => {
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues(bytes: Uint8Array) {
          for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
          return bytes;
        },
      },
    });

    try {
      const rpc = makeRpc(async () => ({ steerId: "s1" }));

      await executeSteer({
        rpc,
        threadId: "thread-1",
        content: "legacy browser",
        contextItems: [],
        images: [],
        dispatch: mock(() => {}),
        clearThreadInput: mock(() => {}),
        clearPendingImages: mock(() => {}),
        clearContextItems: mock(() => {}),
      });

      const [method, params] = (rpc.request as ReturnType<typeof mock>).mock.calls[0] as [string, { steerId: string }];
      expect(method).toBe("turn/steer");
      expect(params.steerId).toBe("steer-00010203-0405-4607-8809-0a0b0c0d0e0f");
    } finally {
      if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
      else Reflect.deleteProperty(globalThis, "crypto");
    }
  });

  test("includes image attachments in turn/steer request", async () => {
    const rpc = makeRpc(async () => ({ steerId: "s1" }));

    await executeSteer({
      rpc,
      threadId: "thread-1",
      content: "check this",
      contextItems: [],
      images: [
        { type: "local_image", path: "/tmp/a.png", mediaType: "image/png", fileName: "a.png", webUrl: "blob:a" },
        { type: "local_image", path: "/tmp/b.jpg", mediaType: "image/jpeg", fileName: "b.jpg", webUrl: "blob:b" },
      ],
      dispatch: mock(() => {}),
      clearThreadInput: mock(() => {}),
      clearPendingImages: mock(() => {}),
      clearContextItems: mock(() => {}),
    });

    const [, params] = (rpc.request as ReturnType<typeof mock>).mock.calls[0] as [string, { attachments: unknown[] }];
    expect(params.attachments).toEqual([
      { type: "local_image", path: "/tmp/a.png", mediaType: "image/png", fileName: "a.png" },
      { type: "local_image", path: "/tmp/b.jpg", mediaType: "image/jpeg", fileName: "b.jpg" },
    ]);
  });

  test("swallows RPC errors without re-throwing", async () => {
    const rpc = makeRpc(async () => {
      throw new Error("network failure");
    });

    await expect(
      executeSteer({
        rpc,
        threadId: "thread-1",
        content: "hello",
        contextItems: [],
        images: [],
        dispatch: mock(() => {}),
        clearThreadInput: mock(() => {}),
        clearPendingImages: mock(() => {}),
        clearContextItems: mock(() => {}),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("executeCancelSteer", () => {
  test("sends cancel RPC and removes local pending steer when accepted", async () => {
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({ cancelled: true }));

    await executeCancelSteer({
      rpc,
      threadId: "thread-1",
      steerId: "s1",
      dispatch: (action) => dispatched.push(action),
    });

    expect(rpc.request).toHaveBeenCalledWith("turn/steer/cancel", {
      threadId: "thread-1",
      steerId: "s1",
    });
    expect(dispatched).toEqual([{ type: "cancel_pending_steer", payload: { steerId: "s1" } }]);
  });

  test("removes local pending steer optimistically even when server rejects cancel", async () => {
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({ cancelled: false }));

    await executeCancelSteer({
      rpc,
      threadId: "thread-1",
      steerId: "s1",
      dispatch: (action) => dispatched.push(action),
    });

    expect(dispatched).toEqual([{ type: "cancel_pending_steer", payload: { steerId: "s1" } }]);
  });
});

describe("executeUpdateSteer", () => {
  test("sends update RPC and updates local pending steer when accepted", async () => {
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({ updated: true }));

    await executeUpdateSteer({
      rpc,
      threadId: "thread-1",
      steerId: "s1",
      content: "new steer",
      dispatch: (action) => dispatched.push(action),
    });

    expect(rpc.request).toHaveBeenCalledWith("turn/steer/update", {
      threadId: "thread-1",
      steerId: "s1",
      content: "new steer",
    });
    expect(dispatched).toEqual([{ type: "update_pending_steer", payload: { steerId: "s1", content: "new steer" } }]);
  });

  test("updates local pending steer optimistically even when server rejects update", async () => {
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({ updated: false }));

    await executeUpdateSteer({
      rpc,
      threadId: "thread-1",
      steerId: "s1",
      content: "new steer",
      dispatch: (action) => dispatched.push(action),
    });

    expect(dispatched).toEqual([{ type: "update_pending_steer", payload: { steerId: "s1", content: "new steer" } }]);
  });
});

describe("executeRestartFromAbort", () => {
  test("dispatches consume_first_pending_steer and local_user then sends turn/start", async () => {
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({}));

    await executeRestartFromAbort({
      rpc,
      threadId: "thread-1",
      restartMessage: "retry this",
      hadItemsBeforeRestart: true,
      model: "claude-4",
      dispatch: (action) => dispatched.push(action),
    });

    expect(dispatched).toEqual([
      { type: "consume_first_pending_steer" },
      { type: "local_user", payload: { text: "retry this", images: [], contextItems: [] } },
    ]);
    expect(rpc.request).toHaveBeenCalledTimes(1);
    const [method, params] = (rpc.request as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      { message: string; model: string },
    ];
    expect(method).toBe("turn/start");
    expect(params.message).toBe("retry this");
    expect(params.model).toBe("claude-4");
  });

  test("adds optimistic_thread dispatch when thread had no prior items", async () => {
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({}));

    await executeRestartFromAbort({
      rpc,
      threadId: "thread-new",
      restartMessage: "first message",
      hadItemsBeforeRestart: false,
      model: undefined,
      dispatch: (action) => dispatched.push(action),
    });

    expect(dispatched).toContainEqual({
      type: "optimistic_thread",
      payload: { threadId: "thread-new", message: "first message" },
    });
  });

  test("skips optimistic_thread dispatch when thread already had items", async () => {
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({}));

    await executeRestartFromAbort({
      rpc,
      threadId: "thread-existing",
      restartMessage: "retry",
      hadItemsBeforeRestart: true,
      model: undefined,
      dispatch: (action) => dispatched.push(action),
    });

    expect(dispatched.some((a) => (a as { type: string }).type === "optimistic_thread")).toBe(false);
  });

  test("sends content array with text block in turn/start request", async () => {
    const rpc = makeRpc(async () => ({}));

    await executeRestartFromAbort({
      rpc,
      threadId: "thread-1",
      restartMessage: "restart message",
      hadItemsBeforeRestart: true,
      model: undefined,
      dispatch: mock(() => {}),
    });

    const [, params] = (rpc.request as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      { content: { type: string; text: string }[] },
    ];
    expect(params.content).toEqual([{ type: "text", text: "restart message" }]);
  });

  test("keeps attached context in turn/start request but strips it from the local user item", async () => {
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({}));
    const restartMessage = [
      "<AttachedContext>",
      "- Instance: Name=Cube; ClassType=Part; GUID=guid-1",
      "</AttachedContext>",
      "retry this",
    ].join("\n");

    await executeRestartFromAbort({
      rpc,
      threadId: "thread-1",
      restartMessage,
      hadItemsBeforeRestart: false,
      model: undefined,
      dispatch: (action) => dispatched.push(action),
    });

    expect(dispatched).toContainEqual({
      type: "local_user",
      payload: {
        text: "retry this",
        images: [],
        contextItems: [{ kind: "instance", source: "studiorpc", GUID: "guid-1", ClassType: "Part", Name: "Cube" }],
      },
    });
    expect(dispatched).toContainEqual({
      type: "optimistic_thread",
      payload: { threadId: "thread-1", message: "retry this" },
    });
    const [, params] = (rpc.request as ReturnType<typeof mock>).mock.calls[0] as [string, { message: string }];
    expect(params.message).toBe(restartMessage);
  });
});
