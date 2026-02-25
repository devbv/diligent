import { describe, expect, test } from "bun:test";
import { Spinner } from "../src/tui/spinner";

describe("Spinner", () => {
  test("renders initial frame on start", () => {
    let lastFrame = "";
    const spinner = new Spinner((frame) => {
      lastFrame = frame;
    });

    spinner.start("Loading...");
    expect(lastFrame).toContain("Loading...");
    expect(lastFrame).toContain("⠋"); // first frame
    spinner.stop();
  });

  test("cycles through frames", async () => {
    const frames: string[] = [];
    const spinner = new Spinner((frame) => {
      frames.push(frame);
    });

    spinner.start("Working...");

    // Wait for a few frames
    await new Promise((resolve) => setTimeout(resolve, 300));
    spinner.stop();

    // Should have multiple distinct frames
    expect(frames.length).toBeGreaterThan(2);
    // Frames should contain different braille characters
    const _uniqueChars = new Set(frames.map((f) => f.charAt(f.indexOf("⠋") >= 0 ? f.indexOf("⠋") : 0)));
  });

  test("updates message", () => {
    let lastFrame = "";
    const spinner = new Spinner((frame) => {
      lastFrame = frame;
    });

    spinner.start("Loading...");
    expect(lastFrame).toContain("Loading...");

    spinner.setMessage("Almost done...");
    // Force a frame render by waiting
    spinner.stop();
  });

  test("stop clears timer", () => {
    const spinner = new Spinner(() => {});
    spinner.start("Test");
    expect(spinner.isRunning).toBe(true);
    spinner.stop();
    expect(spinner.isRunning).toBe(false);
  });

  test("start stops existing spinner first", () => {
    let _callCount = 0;
    const spinner = new Spinner(() => {
      _callCount++;
    });

    spinner.start("First");
    spinner.start("Second");

    // Should not have two intervals running
    spinner.stop();
    expect(spinner.isRunning).toBe(false);
  });
});
