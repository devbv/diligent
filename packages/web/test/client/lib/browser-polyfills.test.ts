import { describe, expect, test } from "bun:test";
import "core-js/actual/array/at";
import "core-js/actual/array/find-last";
import "core-js/actual/array/find-last-index";
import "core-js/actual/object/has-own";
import "core-js/actual/string/at";

describe("browser polyfills", () => {
  test("provides built-ins missing from Chrome 90 WebView", () => {
    expect(Object.hasOwn({ own: true }, "own")).toBe(true);
    expect(Object.hasOwn(Object.create({ inherited: true }), "inherited")).toBe(false);

    expect(["first", "second", "third"].at(-1)).toBe("third");
    expect("abc".at(-1)).toBe("c");

    expect([1, 2, 3, 4].findLast((value) => value % 2 === 0)).toBe(4);
    expect([1, 2, 3, 4].findLastIndex((value) => value % 2 === 0)).toBe(3);
  });
});
