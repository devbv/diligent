// @summary Enforces runtime eval tool allowlists, workspace confinement, budgets, and trace capture

import { isAbsolute, resolve } from "node:path";
import type { Tool } from "@diligent/core/tool-contract";
import type { RuntimeEvalToolPolicy, RuntimeToolCapability, RuntimeToolTrace } from "../runtime-task";
import { normalizePlatformAlias, resolveWorkspacePath } from "./runtime-workspace";

const CAPABILITIES: Record<string, RuntimeToolCapability> = {
  read: "read",
  grep: "read",
  glob: "read",
  ls: "read",
  read_image: "read",
  write: "write",
  edit: "write",
  multi_edit: "write",
  apply_patch: "write",
  bash: "execute",
  skill: "skill",
  search_knowledge: "knowledge",
  update_knowledge: "knowledge",
  request_user_input: "user_input",
  spawn_agent: "collab",
  send_input: "collab",
  wait: "collab",
  close_agent: "collab",
};

const PATH_KEYS = new Set(["path", "file", "file_path", "filePath", "cwd", "directory"]);
const MAX_REGISTERED_OUTPUT_READ_LINES = 2_000;

export type RuntimeEvalOperationBudgetReason = "tool_call_limit" | "user_input_limit" | "child_agent_limit";

export function transformRuntimeTools(input: {
  tools: Tool[];
  root: string;
  outputRoot?: string;
  registeredReadPaths?: ReadonlySet<string>;
  policy: RuntimeEvalToolPolicy;
  traces: RuntimeToolTrace[];
  maxToolCalls: number;
  maxUserInputRequests: number;
  maxChildAgents: number;
  isTerminated: () => boolean;
  onBudgetExceeded: (reason: RuntimeEvalOperationBudgetReason) => void;
  afterMutation?: () => Promise<void>;
}): Tool[] {
  const allowedTools = input.policy.allowedTools ? new Set(input.policy.allowedTools) : undefined;
  const allowedCapabilities = new Set(input.policy.allowedCapabilities);
  return input.tools
    .filter((tool) => {
      const capability = capabilityForTool(tool.name);
      return (!allowedTools || allowedTools.has(tool.name)) && allowedCapabilities.has(capability);
    })
    .map((tool) => ({
      ...tool,
      description:
        tool.name === "bash"
          ? describeEvalCommandContract(tool.description, input.policy.allowedCommands)
          : tool.description,
      async execute(args, context) {
        const capability = capabilityForTool(tool.name);
        const trace: RuntimeToolTrace = {
          sequence: input.traces.length + 1,
          toolCallId: context.toolCallId,
          name: tool.name,
          capability,
          input: normalizeEvidence(args, input.root, input.outputRoot),
          outcome: "success",
        };
        input.traces.push(trace);
        try {
          if (input.isTerminated()) rejectPolicy("execution_terminated", "Eval execution already terminated.");
          if (input.traces.length > input.maxToolCalls) {
            input.onBudgetExceeded("tool_call_limit");
            rejectPolicy("tool_calls", `Tool-call budget exceeded (${input.maxToolCalls}).`);
          }
          enforceOperationLimit(tool.name, input);
          try {
            validateToolInput(tool.name, args, input.root, input.policy, input.registeredReadPaths);
          } catch (error) {
            if (error instanceof RuntimeEvalPolicyRejection) throw error;
            rejectPolicy("tool_input", error instanceof Error ? error.message : String(error));
          }
          const result = await tool.execute(args, context);
          trace.output = normalizeEvidence(result, input.root, input.outputRoot);
          if (result.metadata?.error === true) {
            trace.outcome = "runtime_error";
            trace.error = normalizeEvidence(result.output, input.root, input.outputRoot) as string;
          }
          if (capability === "write" || capability === "execute") await input.afterMutation?.();
          return result;
        } catch (error) {
          trace.error = normalizeEvidence(
            error instanceof Error ? error.message : String(error),
            input.root,
            input.outputRoot,
          ) as string;
          if (error instanceof RuntimeEvalPolicyRejection) {
            trace.outcome = "policy_rejection";
            const result = {
              output: `Error: ${trace.error}`,
              metadata: { error: true, runtimeEvalRejected: true },
            };
            trace.output = normalizeEvidence(result, input.root, input.outputRoot);
            return result;
          }
          trace.outcome = "runtime_error";
          const result = { output: `Error: ${trace.error}`, metadata: { error: true } };
          trace.output = normalizeEvidence(result, input.root, input.outputRoot);
          return result;
        }
      },
    }));
}

function describeEvalCommandContract(description: string, allowedCommands: readonly string[]): string {
  const contract =
    allowedCommands.length === 0
      ? "no command strings are permitted."
      : `only these exact command strings are permitted: ${allowedCommands.map((command) => JSON.stringify(command)).join(", ")}.`;
  return `${description}\n\nRuntime eval command contract: ${contract}`;
}

class RuntimeEvalPolicyRejection extends Error {}

function rejectPolicy(code: string, message: string): never {
  throw new RuntimeEvalPolicyRejection(`runtime_eval_policy.${code}: ${message}`);
}

function enforceOperationLimit(
  toolName: string,
  input: Pick<
    Parameters<typeof transformRuntimeTools>[0],
    "traces" | "maxUserInputRequests" | "maxChildAgents" | "onBudgetExceeded"
  >,
): void {
  const priorRuns = input.traces.filter(
    (trace) => trace.name === toolName && trace.outcome !== "policy_rejection",
  ).length;
  if (toolName === "request_user_input" && priorRuns > input.maxUserInputRequests) {
    input.onBudgetExceeded("user_input_limit");
    rejectPolicy("user_input_requests", `User-input request limit exceeded (${input.maxUserInputRequests}).`);
  }
  if (toolName === "spawn_agent" && priorRuns > input.maxChildAgents) {
    input.onBudgetExceeded("child_agent_limit");
    rejectPolicy("child_agents", `Child-agent limit exceeded (${input.maxChildAgents}).`);
  }
}

export function capabilityForTool(name: string): RuntimeToolCapability {
  return CAPABILITIES[name] ?? "execute";
}

function validateToolInput(
  name: string,
  args: unknown,
  root: string,
  policy: RuntimeEvalToolPolicy,
  registeredReadPaths?: ReadonlySet<string>,
): void {
  if (name === "bash") {
    const command = isRecord(args) && typeof args.command === "string" ? args.command.trim() : "";
    if (!policy.allowedCommands.includes(command)) {
      throw new Error(`runtime_contract.forbidden_command: ${command || "<missing>"}`);
    }
  }
  visit(args, (key, value) => {
    if (PATH_KEYS.has(key) && typeof value === "string") resolveEvalToolPath(name, root, value, registeredReadPaths);
  });
  if (name === "read" && isRecord(args) && typeof args.file_path === "string") {
    const resolved = normalizePlatformAlias(resolve(args.file_path));
    if (registeredReadPaths?.has(resolved)) {
      const limit = args.limit ?? MAX_REGISTERED_OUTPUT_READ_LINES;
      if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_REGISTERED_OUTPUT_READ_LINES
      )
        throw new Error(
          `runtime_contract.output_read_limit: registered output reads are limited to ${MAX_REGISTERED_OUTPUT_READ_LINES} lines.`,
        );
    }
  }
  if (name === "apply_patch" && isRecord(args)) {
    const patch = typeof args.patch === "string" ? args.patch : typeof args.input === "string" ? args.input : "";
    for (const match of patch.matchAll(/^\*{3} (?:Add|Update|Delete) File: (.+)$/gm))
      resolveWorkspacePath(root, match[1]!);
    for (const match of patch.matchAll(/^\*{3} Move to: (.+)$/gm)) resolveWorkspacePath(root, match[1]!);
  }
}

function resolveEvalToolPath(
  toolName: string,
  root: string,
  candidate: string,
  registeredReadPaths?: ReadonlySet<string>,
): string {
  try {
    return resolveWorkspacePath(root, candidate);
  } catch (error) {
    if (
      capabilityForTool(toolName) === "read" &&
      isAbsolute(candidate) &&
      registeredReadPaths?.has(normalizePlatformAlias(resolve(candidate)))
    ) {
      return resolve(candidate);
    }
    throw error;
  }
}

function normalizeEvidence(value: unknown, root: string, outputRoot?: string): unknown {
  if (typeof value === "string") {
    const aliasedRoot = process.platform === "darwin" ? `/private${normalizePlatformAlias(root)}` : root;
    const aliasedOutputRoot =
      outputRoot && process.platform === "darwin" ? `/private${normalizePlatformAlias(outputRoot)}` : outputRoot;
    const normalized = value
      .split(aliasedOutputRoot ?? "\0")
      .join("$TOOL_OUTPUT")
      .split(outputRoot ?? "\0")
      .join("$TOOL_OUTPUT")
      .split(aliasedRoot)
      .join("$WORKSPACE")
      .split(root)
      .join("$WORKSPACE")
      .slice(0, 16_384);
    return normalizeEvidencePath(normalized);
  }
  if (Array.isArray(value)) return value.map((item) => normalizeEvidence(item, root, outputRoot));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "data" && isRecord(value) && value.type === "base64"
        ? "[base64 omitted]"
        : normalizeEvidence(item, root, outputRoot),
    ]),
  );
}

export function normalizeEvidencePath(value: string): string {
  return value.replace(/\$(?:WORKSPACE|TOOL_OUTPUT)(?:\\[^\\'"\r\n]+)+/g, (path) => path.replaceAll("\\", "/"));
}

function visit(value: unknown, callback: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      callback(key, item);
      visit(item, callback);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
