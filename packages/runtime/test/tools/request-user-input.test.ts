// @summary Tests for request_user_input tool — ctx.ask wiring and answer formatting
import { describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import type { ToolContext } from "@diligent/core/tool/types";
import { createRequestUserInputTool } from "../../src/tools/request-user-input";
import type { UserInputRequest, UserInputResponse } from "../../src/tools/user-input-types";

function makeCtx(): ToolContext & { abortCalled: boolean } {
  const ctx = {
    toolCallId: "tc-1",
    signal: new AbortController().signal,
    abortCalled: false,
    abort() {
      ctx.abortCalled = true;
    },
  };
  return ctx;
}

const YES_NO_OPTIONS = [
  { label: "Yes", description: "Proceed with the action" },
  { label: "No", description: "Skip and do nothing" },
];

setDefaultTimeout(5_000);

describe("createRequestUserInputTool", () => {
  it("returns fallback message when ask capability is not available", async () => {
    const tool = createRequestUserInputTool();
    const result = await tool.execute(
      { questions: [{ id: "q1", header: "confirm", question: "Continue?", options: YES_NO_OPTIONS }] },
      makeCtx(),
    );
    expect(result.output).toBe("User input not available in this context.");
  });

  it("returns a self-answer directive when auto progress mode is enabled", async () => {
    const ask = mock(async () => ({ answers: { asset: "asset-2" } }));
    const tool = createRequestUserInputTool({ ask, getAutoProgressMode: () => true });
    const result = await tool.execute(
      {
        questions: [
          {
            id: "asset",
            header: "Asset",
            question: "Pick one",
            options: [
              { label: "Castle", description: "First result", value: "asset-1" },
              { label: "Tower", description: "Second result", value: "asset-2" },
            ],
          },
        ],
      },
      makeCtx(),
    );

    expect(result.output).toContain("Auto progress mode is currently enabled.");
    expect(result.output).toContain("Answer the following question(s) yourself");
    expect(result.output).toContain("You may call request_user_input again later for a different question");
    expect(result.output).toContain("[Asset] Pick one");
    expect(result.output).toContain("- Castle (value: asset-1): First result");
    expect(result.output).toContain("- Tower (value: asset-2): Second result");
    expect(ask).not.toHaveBeenCalled();
  });

  it("self-answer directive preserves multi-select prompts", async () => {
    const tool = createRequestUserInputTool({ getAutoProgressMode: () => true });
    const result = await tool.execute(
      {
        questions: [
          {
            id: "features",
            header: "Features",
            question: "Pick features",
            allow_multiple: true,
            options: [
              { label: "Movement", description: "Add movement" },
              { label: "Combat", description: "Add combat" },
            ],
          },
        ],
      },
      makeCtx(),
    );

    expect(result.output).toContain("[Features] Pick features");
    expect(result.output).toContain("Select one or more options if appropriate.");
    expect(result.output).toContain("- Movement: Add movement");
    expect(result.output).toContain("- Combat: Add combat");
  });

  it("reads auto progress mode dynamically from an existing tool host", async () => {
    let autoProgressMode = false;
    const ask = mock(async () => ({ answers: { q1: "Manual" } }));
    const tool = createRequestUserInputTool({
      ask,
      getAutoProgressMode: () => autoProgressMode,
    });

    const args = { questions: [{ id: "q1", header: "confirm", question: "Continue?", options: YES_NO_OPTIONS }] };

    await expect(tool.execute(args, makeCtx())).resolves.toMatchObject({
      output: "[confirm] Continue?\nAnswer: Manual",
    });
    autoProgressMode = true;
    const result = await tool.execute(args, makeCtx());
    expect(result.output).toContain("Auto progress mode is currently enabled.");
    expect(result.output).toContain("[confirm] Continue?");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("formats single question answer with header prefix", async () => {
    const tool = createRequestUserInputTool(asyncHost(async () => ({ answers: { q1: "Yes" } })));
    const result = await tool.execute(
      { questions: [{ id: "q1", header: "confirm", question: "Continue?", options: YES_NO_OPTIONS }] },
      makeCtx(),
    );
    expect(result.output).toBe("[confirm] Continue?\nAnswer: Yes");
  });

  it("formats multiple questions with double newline separator", async () => {
    const tool = createRequestUserInputTool(asyncHost(async () => ({ answers: { q1: "Fix in place", q2: "Yes" } })));
    const result = await tool.execute(
      {
        questions: [
          {
            id: "q1",
            header: "approach",
            question: "Which approach?",
            options: [
              { label: "Fix in place", description: "Minimal change" },
              { label: "Rewrite", description: "Clean slate" },
            ],
          },
          {
            id: "q2",
            header: "confirm",
            question: "Proceed?",
            options: YES_NO_OPTIONS,
          },
        ],
      },
      makeCtx(),
    );
    expect(result.output).toBe("[approach] Which approach?\nAnswer: Fix in place\n\n[confirm] Proceed?\nAnswer: Yes");
  });

  it("calls ctx.abort() when question answer is missing", async () => {
    const tool = createRequestUserInputTool(asyncHost(async () => ({ answers: {} })));
    const ctx = makeCtx();
    const result = await tool.execute(
      { questions: [{ id: "q1", header: "info", question: "Any thoughts?", options: YES_NO_OPTIONS }] },
      ctx,
    );
    expect(ctx.abortCalled).toBe(true);
    expect(result.output).toContain("[Cancelled by user]");
  });

  it("calls ctx.abort() when question answer is blank", async () => {
    const tool = createRequestUserInputTool(asyncHost(async () => ({ answers: { q1: "   " } })));
    const ctx = makeCtx();
    const result = await tool.execute(
      { questions: [{ id: "q1", header: "info", question: "Any thoughts?", options: YES_NO_OPTIONS }] },
      ctx,
    );
    expect(ctx.abortCalled).toBe(true);
    expect(result.output).toContain("[Cancelled by user]");
  });

  it("formats multi-select answers by joining selected values", async () => {
    const tool = createRequestUserInputTool(asyncHost(async () => ({ answers: { q1: ["A", "C"] } })));
    const result = await tool.execute(
      {
        questions: [
          {
            id: "q1",
            header: "choices",
            question: "Pick options",
            allow_multiple: true,
            options: [
              { label: "A", description: "Option A" },
              { label: "B", description: "Option B" },
              { label: "C", description: "Option C" },
            ],
          },
        ],
      },
      makeCtx(),
    );
    expect(result.output).toBe("[choices] Pick options\nAnswer: A, C");
  });

  it("calls ctx.abort() when multi-select answer is empty", async () => {
    const tool = createRequestUserInputTool(asyncHost(async () => ({ answers: { q1: [] } })));
    const ctx = makeCtx();
    const result = await tool.execute(
      {
        questions: [
          {
            id: "q1",
            header: "choices",
            question: "Pick options",
            allow_multiple: true,
            options: [
              { label: "A", description: "Option A" },
              { label: "B", description: "Option B" },
            ],
          },
        ],
      },
      ctx,
    );
    expect(ctx.abortCalled).toBe(true);
    expect(result.output).toContain("[Cancelled by user]");
  });

  it("rejects call when options array is empty", () => {
    const tool = createRequestUserInputTool();
    const parsed = tool.parameters.safeParse({
      questions: [{ id: "q1", header: "bad", question: "No options?", options: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects call when more than 3 questions", async () => {
    const q = { id: "q", header: "h", question: "Q?", options: YES_NO_OPTIONS };
    const tool = createRequestUserInputTool();
    const parsed = tool.parameters.safeParse({ questions: [q, q, q, q] });
    expect(parsed.success).toBe(false);
  });

  it("rejects call when header exceeds 12 characters", async () => {
    const tool = createRequestUserInputTool();
    const parsed = tool.parameters.safeParse({
      questions: [{ id: "q1", header: "toolongheader", question: "Q?", options: YES_NO_OPTIONS }],
    });
    expect(parsed.success).toBe(false);
  });
});

function asyncHost(ask: (req: UserInputRequest) => Promise<UserInputResponse>) {
  return { ask };
}
