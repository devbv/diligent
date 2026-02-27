import { describe, expect, test } from "bun:test";
import { LoopDetector } from "../src/agent/loop-detector";

describe("LoopDetector", () => {
  test("no detection with insufficient calls", () => {
    const d = new LoopDetector();
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    expect(d.check().detected).toBe(false);
  });

  test("length-1: detects same call 3 times", () => {
    const d = new LoopDetector();
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    const result = d.check();
    expect(result.detected).toBe(true);
    expect(result.patternLength).toBe(1);
    expect(result.toolName).toBe("bash");
  });

  test("length-1: different inputs are not a loop", () => {
    const d = new LoopDetector();
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "pwd" });
    d.record("bash", { command: "date" });
    expect(d.check().detected).toBe(false);
  });

  test("length-2: detects A-B-A-B-A-B pattern", () => {
    const d = new LoopDetector();
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
    const d = new LoopDetector();
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

  test("window limits stored signatures", () => {
    const d = new LoopDetector(5);
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
    const d = new LoopDetector();
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    d.record("bash", { command: "ls" });
    expect(d.check().detected).toBe(true);
    // Break the pattern
    d.record("read", { path: "/tmp" });
    expect(d.check().detected).toBe(false);
  });

  test("detects loop in later calls (not just from start)", () => {
    const d = new LoopDetector();
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
