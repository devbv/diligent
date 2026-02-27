import { describe, expect, test } from "bun:test";
import { StatusBar } from "../src/tui/components/status-bar";

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: needed to strip ANSI
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("StatusBar mode hint (right side)", () => {
  test("mode 'default' shows no mode hint", () => {
    const bar = new StatusBar();
    bar.update({ model: "test-model", mode: "default", status: "idle" });
    const text = stripAnsi(bar.render(120).join(""));
    expect(text).not.toContain("mode  (shift+tab");
    expect(text).not.toContain("[default]");
  });

  test("mode undefined shows no mode hint", () => {
    const bar = new StatusBar();
    bar.update({ model: "test-model", status: "idle" });
    const text = stripAnsi(bar.render(120).join(""));
    expect(text).not.toContain("mode  (shift+tab");
  });

  test("mode 'plan' shows 'plan mode  (shift+tab to cycle)' on right", () => {
    const bar = new StatusBar();
    bar.update({ model: "test-model", mode: "plan", status: "idle" });
    const text = stripAnsi(bar.render(120).join(""));
    expect(text).toContain("plan mode  (shift+tab to cycle)");
  });

  test("mode 'execute' shows 'execute mode  (shift+tab to cycle)' on right", () => {
    const bar = new StatusBar();
    bar.update({ model: "test-model", mode: "execute", status: "idle" });
    const text = stripAnsi(bar.render(120).join(""));
    expect(text).toContain("execute mode  (shift+tab to cycle)");
  });

  test("mode hint right of model name", () => {
    const bar = new StatusBar();
    bar.update({ model: "my-model", mode: "plan", status: "idle" });
    const text = stripAnsi(bar.render(120).join(""));
    const modelIndex = text.indexOf("my-model");
    const hintIndex = text.indexOf("plan mode");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(hintIndex).toBeGreaterThanOrEqual(0);
    expect(hintIndex).toBeGreaterThan(modelIndex);
  });

  test("busy status takes priority over mode hint", () => {
    const bar = new StatusBar();
    bar.update({ model: "test-model", mode: "plan", status: "busy" });
    const text = stripAnsi(bar.render(120).join(""));
    expect(text).toContain("ctrl+c to cancel");
    expect(text).not.toContain("shift+tab");
  });

  test("update from plan to default removes mode hint", () => {
    const bar = new StatusBar();
    bar.update({ mode: "plan", status: "idle" });
    expect(stripAnsi(bar.render(120).join(""))).toContain("plan mode");
    bar.update({ mode: "default" });
    expect(stripAnsi(bar.render(120).join(""))).not.toContain("plan mode");
  });
});
