import { describe, expect, test } from "bun:test";
import { EventStream } from "../src/event-stream";

type TestEvent = { type: "data"; value: string } | { type: "done"; result: number };

function createTestStream() {
  return new EventStream<TestEvent, number>(
    (event) => event.type === "done",
    (event) => (event as { type: "done"; result: number }).result,
  );
}

describe("EventStream", () => {
  test("push events, iterate with for-await, verify order", async () => {
    const stream = createTestStream();

    stream.push({ type: "data", value: "a" });
    stream.push({ type: "data", value: "b" });
    stream.push({ type: "done", result: 42 });

    const events: TestEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "data", value: "a" },
      { type: "data", value: "b" },
      { type: "done", result: 42 },
    ]);
  });

  test("consumer waits for push (backpressure)", async () => {
    const stream = createTestStream();

    const collected: string[] = [];
    const iterating = (async () => {
      for await (const event of stream) {
        if (event.type === "data") collected.push(event.value);
      }
    })();

    // Small delay to let iterator start waiting
    await new Promise((r) => setTimeout(r, 10));
    stream.push({ type: "data", value: "delayed" });
    stream.push({ type: "done", result: 1 });

    await iterating;
    expect(collected).toEqual(["delayed"]);
  });

  test("result() resolves after terminal event", async () => {
    const stream = createTestStream();

    stream.push({ type: "data", value: "x" });
    stream.push({ type: "done", result: 99 });

    const result = await stream.result();
    expect(result).toBe(99);
  });

  test("end(result) resolves without terminal event", async () => {
    const stream = createTestStream();

    stream.push({ type: "data", value: "x" });
    stream.end(55);

    const result = await stream.result();
    expect(result).toBe(55);
  });

  test("error(err) rejects the result promise", async () => {
    const stream = createTestStream();

    stream.error(new Error("test error"));

    await expect(stream.result()).rejects.toThrow("test error");
  });

  test("iteration stops after end()", async () => {
    const stream = createTestStream();

    stream.push({ type: "data", value: "a" });
    stream.end(10);

    const events: TestEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "data", value: "a" }]);
  });

  test("iteration stops after error()", async () => {
    const stream = createTestStream();

    // Catch the rejected promise to prevent unhandled rejection
    stream.result().catch(() => {});

    stream.push({ type: "data", value: "a" });
    stream.error(new Error("fail"));

    const events: TestEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "data", value: "a" }]);
  });

  test("late pushes after end() are ignored", async () => {
    const stream = createTestStream();

    stream.push({ type: "data", value: "a" });
    stream.end(1);
    stream.push({ type: "data", value: "b" }); // should be ignored

    const events: TestEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "data", value: "a" }]);
    expect(await stream.result()).toBe(1);
  });
});
