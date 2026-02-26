import { describe, expect, test } from "bun:test";
import { OverlayStack } from "../overlay";
import type { Component } from "../types";

function createComponent(lines: string[]): Component {
  return {
    render: () => [...lines],
    invalidate: () => {},
  };
}

describe("OverlayStack", () => {
  test("starts empty", () => {
    const stack = new OverlayStack();
    expect(stack.hasVisible()).toBe(false);
    expect(stack.getVisible()).toEqual([]);
    expect(stack.getTopComponent()).toBeNull();
  });

  test("shows overlay", () => {
    const stack = new OverlayStack();
    const dialog = createComponent(["hello"]);
    stack.show(dialog);

    expect(stack.hasVisible()).toBe(true);
    expect(stack.getVisible()).toHaveLength(1);
    expect(stack.getTopComponent()).toBe(dialog);
  });

  test("hides overlay via handle", () => {
    const stack = new OverlayStack();
    const dialog = createComponent(["hello"]);
    const handle = stack.show(dialog);

    handle.hide();
    expect(stack.hasVisible()).toBe(false);
    expect(stack.getTopComponent()).toBeNull();
  });

  test("setHidden toggles visibility", () => {
    const stack = new OverlayStack();
    const dialog = createComponent(["hello"]);
    const handle = stack.show(dialog);

    handle.setHidden(true);
    expect(handle.isHidden()).toBe(true);
    expect(stack.hasVisible()).toBe(false);

    handle.setHidden(false);
    expect(handle.isHidden()).toBe(false);
    expect(stack.hasVisible()).toBe(true);
  });

  test("hideTop removes topmost overlay", () => {
    const stack = new OverlayStack();
    const first = createComponent(["first"]);
    const second = createComponent(["second"]);
    stack.show(first);
    stack.show(second);

    stack.hideTop();
    expect(stack.getVisible()).toHaveLength(1);
    expect(stack.getTopComponent()).toBe(first);
  });

  test("getTopComponent returns topmost visible", () => {
    const stack = new OverlayStack();
    const first = createComponent(["first"]);
    const second = createComponent(["second"]);
    stack.show(first);
    const handle = stack.show(second);

    handle.setHidden(true);
    expect(stack.getTopComponent()).toBe(first);
  });

  test("clear removes all overlays", () => {
    const stack = new OverlayStack();
    stack.show(createComponent(["a"]));
    stack.show(createComponent(["b"]));
    stack.clear();

    expect(stack.hasVisible()).toBe(false);
    expect(stack.getVisible()).toEqual([]);
  });

  test("preserves overlay options", () => {
    const stack = new OverlayStack();
    const dialog = createComponent(["hello"]);
    stack.show(dialog, { anchor: "center", width: 40 });

    const visible = stack.getVisible();
    expect(visible[0].options.anchor).toBe("center");
    expect(visible[0].options.width).toBe(40);
  });
});
