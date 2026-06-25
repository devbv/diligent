// @summary Tests for steering queue helper functions covering steer RPC, abort-restart, and image attachments
import { describe, expect, mock, test } from "bun:test";
import { executeRestartFromAbort, executeSteer } from "../../../src/client/lib/use-steering-queue";

function makeRpc(handler: (method: string, params: unknown) => unknown) {
  return { request: mock(handler) } as never;
}

describe("executeSteer", () => {
  test("dispatches local_steer and sends turn/steer RPC", async () => {
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({}));

    await executeSteer({
      rpc,
      threadId: "thread-1",
      content: "hello world",
      images: [],
      dispatch: (action) => dispatched.push(action),
      clearThreadInput: mock(() => {}),
      clearPendingImages: mock(() => {}),
    });

    expect(dispatched).toEqual([{ type: "local_steer", payload: "hello world" }]);
    expect(rpc.request).toHaveBeenCalledTimes(1);
    const [method, params] = (rpc.request as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      { content: string; followUp: boolean },
    ];
    expect(method).toBe("turn/steer");
    expect(params.content).toBe("hello world");
    expect(params.followUp).toBe(false);
  });

  test("clears thread input and pending images before dispatching", async () => {
    const clearThreadInput = mock((_threadId: string) => {});
    const clearPendingImages = mock(() => {});
    const dispatched: unknown[] = [];
    const rpc = makeRpc(async () => ({}));

    await executeSteer({
      rpc,
      threadId: "thread-abc",
      content: "test",
      images: [],
      dispatch: (action) => dispatched.push(action),
      clearThreadInput,
      clearPendingImages,
    });

    expect(clearThreadInput).toHaveBeenCalledWith("thread-abc");
    expect(clearPendingImages).toHaveBeenCalledTimes(1);
    expect(dispatched[0]).toEqual({ type: "local_steer", payload: "test" });
  });

  test("includes image attachments in turn/steer request", async () => {
    const rpc = makeRpc(async () => ({}));

    await executeSteer({
      rpc,
      threadId: "thread-1",
      content: "check this",
      images: [
        { type: "local_image", path: "/tmp/a.png", mediaType: "image/png", fileName: "a.png", webUrl: "blob:a" },
        { type: "local_image", path: "/tmp/b.jpg", mediaType: "image/jpeg", fileName: "b.jpg", webUrl: "blob:b" },
      ],
      dispatch: mock(() => {}),
      clearThreadInput: mock(() => {}),
      clearPendingImages: mock(() => {}),
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
        images: [],
        dispatch: mock(() => {}),
        clearThreadInput: mock(() => {}),
        clearPendingImages: mock(() => {}),
      }),
    ).resolves.toBeUndefined();
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
      { type: "local_user", payload: { text: "retry this", images: [] } },
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
});
