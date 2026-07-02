// @summary Tests for infinite loop detection in agent behavior
import { describe, expect, test } from "bun:test";
import { DoomLoopDetector } from "../../src/agent/util/doom-loop";

describe("DoomLoopDetector", () => {
  test("no detection with insufficient calls", () => {
    const d = new DoomLoopDetector();
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    expect(d.check().detected).toBe(false);
  });

  test("length-1: detects same call 3 times", () => {
    const d = new DoomLoopDetector();
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    const result = d.check();
    expect(result.detected).toBe(true);
    expect(result.patternLength).toBe(1);
    expect(result.toolName).toBe("bash");
  });

  test("length-1: different inputs are not a loop", () => {
    const d = new DoomLoopDetector();
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "pwd" });
    d.record("bash", { command: "date" });
    expect(d.check().detected).toBe(false);
  });

  test("length-2: detects A-B-A-B-A-B pattern", () => {
    const d = new DoomLoopDetector();
    d.record("bash", { command: "ls" });
    d.record("read", { path: "/tmp" });
    d.record("bash", { command: "ls" });
    d.record("read", { path: "/tmp" });
    d.record("bash", { command: "ls" });
    d.record("read", { path: "/tmp" });
    const result = d.check();
    expect(result.detected).toBe(true);
    expect(result.patternLength).toBe(2);
    expect(result.toolName).toBe("bash");
  });

  test("length-3: detects A-B-C-A-B-C-A-B-C pattern", () => {
    const d = new DoomLoopDetector();
    d.record("bash", { command: "ls" });
    d.record("read", { path: "/a" });
    d.record("write", { path: "/b" });
    d.record("bash", { command: "ls" });
    d.record("read", { path: "/a" });
    d.record("write", { path: "/b" });
    d.record("bash", { command: "ls" });
    d.record("read", { path: "/a" });
    d.record("write", { path: "/b" });
    const result = d.check();
    expect(result.detected).toBe(true);
    expect(result.patternLength).toBe(3);
    expect(result.toolName).toBe("bash");
  });

  test("length-4: detects repeated directory probing sequence with default window", () => {
    const d = new DoomLoopDetector();
    const paths = ["/Users/devbv/git", "/Users/devbv/recruit", "/Users/devbv/Documents", "/Users/devbv/Desktop"];

    for (let repeat = 0; repeat < 3; repeat++) {
      for (const path of paths) {
        d.record("ls", { path });
      }
    }

    const result = d.check();
    expect(result.detected).toBe(true);
    expect(result.patternLength).toBe(4);
    expect(result.toolName).toBe("ls");
  });

  test("window limits stored signatures", () => {
    const d = new DoomLoopDetector(5);
    // Fill with unique calls beyond window
    for (let i = 0; i < 10; i++) {
      d.record("bash", { command: `cmd-${i}` });
    }
    expect(d.check().detected).toBe(false);
    // Now add 3 identical calls within window
    d.record("bash", { command: "loop" });
    d.record("bash", { command: "loop" });
    d.record("bash", { command: "loop" });
    expect(d.check().detected).toBe(true);
  });

  test("no false positive after breaking the pattern", () => {
    const d = new DoomLoopDetector();
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    expect(d.check().detected).toBe(true);
    // Break the pattern
    d.record("read", { path: "/tmp" });
    expect(d.check().detected).toBe(false);
  });

  test("detects loop in later calls (not just from start)", () => {
    const d = new DoomLoopDetector();
    d.record("read", { path: "/a" });
    d.record("write", { path: "/b" });
    // Now a length-1 loop begins
    d.record("bash", { command: "fail" });
    d.record("bash", { command: "fail" });
    d.record("bash", { command: "fail" });
    const result = d.check();
    expect(result.detected).toBe(true);
    expect(result.patternLength).toBe(1);
  });
});

describe("doom loop helpers", () => {
  test("detectDoomLoop works via class", () => {
    const d = new DoomLoopDetector();
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });

    expect(d.check()).toEqual({
      detected: true,
      patternLength: 1,
      toolName: "bash",
    });
  });
});
