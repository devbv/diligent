// @summary Candidate core eval task for nested, strongly typed function-tool arguments

import { z } from "zod";
import type { EvalTask } from "../../task";
import { fixtureToken, getFinalText, getToolTrace, isRecord } from "./helpers";

const OPERATIONS = ["archive", "restore"] as const;

export interface StructuredToolArgsWorld {
  recordId: string;
  revision: string;
  operation: (typeof OPERATIONS)[number];
  dryRun: boolean;
  priority: number;
  labels: [string, string];
  receiptToken: string;
  submitted: boolean;
}

export const structuredToolArgsTask: EvalTask<StructuredToolArgsWorld> = {
  id: "structured-tool-args",
  description: "Submits one exact nested job through a strongly typed function-tool schema.",
  systemPrompt: [
    {
      label: "eval-task",
      content:
        "Use the available tool exactly once. Preserve every nested value and type from the request. Finish with the receipt returned by the tool.",
    },
  ],
  limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 120_000, maxOutputTokens: 8_192 },
  createWorld: (seed) => ({
    recordId: fixtureToken(seed, "structured-record-id", "record"),
    revision: fixtureToken(seed, "structured-revision", "revision"),
    operation: "archive",
    dryRun: false,
    priority: 4,
    labels: [
      fixtureToken(seed, "structured-label-primary", "label"),
      fixtureToken(seed, "structured-label-secondary", "label"),
    ],
    receiptToken: fixtureToken(seed, "structured-receipt", "receipt"),
    submitted: false,
  }),
  createTools: (world) => [
    {
      name: "submit_job",
      description: "Submit a typed record operation and return its opaque receipt token.",
      parameters: z.object({
        target: z.object({
          recordId: z.string().describe("Exact record identifier from the user"),
          revision: z.string().describe("Exact opaque record revision from the user"),
        }),
        operation: z.enum(OPERATIONS),
        options: z.object({
          dryRun: z.boolean(),
          priority: z.number().int().min(1).max(5),
          labels: z.array(z.string()).length(2),
        }),
      }),
      async execute(args) {
        const valid =
          args.target.recordId === world.recordId &&
          args.target.revision === world.revision &&
          args.operation === world.operation &&
          args.options.dryRun === world.dryRun &&
          args.options.priority === world.priority &&
          args.options.labels.length === world.labels.length &&
          args.options.labels.every((label: string, index: number) => label === world.labels[index]);
        if (!valid) {
          return { output: "Error: submitted job did not match the requested typed values", metadata: { error: true } };
        }
        world.submitted = true;
        return { output: JSON.stringify({ status: "submitted", receiptToken: world.receiptToken }) };
      },
    },
  ],
  createUserMessage: (world) => ({
    role: "user",
    content: [
      `Submit operation ${world.operation} for record ${world.recordId} at revision ${world.revision}.`,
      `Set dryRun to ${world.dryRun}, priority to ${world.priority}, and labels to [${world.labels.join(", ")}].`,
      "Return the receipt token in the final answer.",
    ].join("\n"),
    timestamp: Date.now(),
  }),
  snapshotWorld: (world) => ({ ...world, labels: [...world.labels] }),
  evaluate: (execution) => {
    const trace = getToolTrace(execution);
    if (trace.length !== 1 || trace[0]?.toolName !== "submit_job") {
      return {
        passed: false,
        code: "structured_tool_args.wrong_trace",
        message: "Expected exactly one submit_job call.",
      };
    }
    const input = trace[0].input;
    if (!isStructuredJobInput(input)) {
      return {
        passed: false,
        code: "structured_tool_args.malformed_input",
        message: "submit_job did not receive the required nested input shape.",
      };
    }
    const expected = execution.world;
    if (
      input.target.recordId !== expected.recordId ||
      input.target.revision !== expected.revision ||
      input.operation !== expected.operation ||
      input.options.dryRun !== expected.dryRun ||
      input.options.priority !== expected.priority ||
      input.options.labels.length !== expected.labels.length ||
      input.options.labels.some((label, index) => label !== expected.labels[index])
    ) {
      return {
        passed: false,
        code: "structured_tool_args.wrong_values",
        message: "submit_job changed one or more typed values.",
      };
    }
    if (!execution.world.submitted) {
      return { passed: false, code: "structured_tool_args.not_submitted", message: "The job was not submitted." };
    }
    if (!getFinalText(execution).includes(execution.world.receiptToken)) {
      return {
        passed: false,
        code: "structured_tool_args.missing_receipt",
        message: "The final answer omitted the receipt token.",
      };
    }
    return { passed: true };
  },
};

interface StructuredJobInput {
  target: { recordId: string; revision: string };
  operation: string;
  options: { dryRun: boolean; priority: number; labels: string[] };
}

function isStructuredJobInput(value: unknown): value is StructuredJobInput {
  if (!isRecord(value) || !isRecord(value.target) || !isRecord(value.options)) return false;
  return (
    typeof value.target.recordId === "string" &&
    typeof value.target.revision === "string" &&
    typeof value.operation === "string" &&
    typeof value.options.dryRun === "boolean" &&
    typeof value.options.priority === "number" &&
    Array.isArray(value.options.labels) &&
    value.options.labels.every((label) => typeof label === "string")
  );
}
