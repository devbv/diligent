// @summary Tests for ephemeral stream turn resource scope lifecycle

import { describe, expect, test } from "bun:test";
import { createStreamTurnScope } from "../../src/llm/turn-scope";

describe("createStreamTurnScope", () => {
  test("reuses resources by symbol and disposes them in reverse creation order", async () => {
    const scope = createStreamTurnScope();
    const first = Symbol("first");
    const second = Symbol("second");
    const disposed: string[] = [];

    expect(
      scope.getOrCreate(first, () => ({
        value: "one",
        dispose: () => {
          disposed.push("one");
        },
      })),
    ).toBe("one");
    expect(
      scope.getOrCreate(first, () => ({
        value: "other",
        dispose: () => {
          disposed.push("other");
        },
      })),
    ).toBe("one");
    scope.getOrCreate(second, () => ({
      value: "two",
      dispose: () => {
        disposed.push("two");
      },
    }));

    await Promise.all([scope.dispose(), scope.dispose()]);
    expect(disposed).toEqual(["two", "one"]);
    expect(() => scope.getOrCreate(Symbol("late"), () => ({ value: "late", dispose: () => {} }))).toThrow("disposed");
  });

  test("continues disposal after failures", async () => {
    const scope = createStreamTurnScope();
    const disposed: string[] = [];
    scope.getOrCreate(Symbol("first"), () => ({
      value: undefined,
      dispose: () => {
        disposed.push("first");
      },
    }));
    scope.getOrCreate(Symbol("bad"), () => ({
      value: undefined,
      dispose: () => {
        throw new Error("bad disposer");
      },
    }));

    await expect(scope.dispose()).rejects.toThrow("bad disposer");
    expect(disposed).toEqual(["first"]);
  });
});
