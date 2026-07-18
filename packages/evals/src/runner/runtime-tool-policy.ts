// @summary Enforces runtime eval tool allowlists, workspace confinement, budgets, and trace capture

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

export function transformRuntimeTools(input: {
  tools: Tool[];
  root: string;
  policy: RuntimeEvalToolPolicy;
  traces: RuntimeToolTrace[];
  maxToolCalls: number;
  isTerminated: () => boolean;
  onBudgetExceeded: () => void;
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
      async execute(args, context) {
        const capability = capabilityForTool(tool.name);
        const trace: RuntimeToolTrace = {
          sequence: input.traces.length + 1,
          name: tool.name,
          capability,
          input: normalizeEvidence(args, input.root),
        };
        input.traces.push(trace);
        try {
          if (input.isTerminated()) throw new Error("Eval execution already terminated.");
          if (input.traces.length > input.maxToolCalls) {
            input.onBudgetExceeded();
            throw new Error(`Tool-call budget exceeded (${input.maxToolCalls}).`);
          }
          validateToolInput(tool.name, args, input.root, input.policy);
          const result = await tool.execute(args, context);
          trace.output = normalizeEvidence(result, input.root);
          if (capability === "write" || capability === "execute") await input.afterMutation?.();
          return result;
        } catch (error) {
          trace.error = error instanceof Error ? error.message : String(error);
          return { output: `Error: ${trace.error}`, metadata: { error: true, runtimeEvalRejected: true } };
        }
      },
    }));
}

export function capabilityForTool(name: string): RuntimeToolCapability {
  return CAPABILITIES[name] ?? "execute";
}

function validateToolInput(name: string, args: unknown, root: string, policy: RuntimeEvalToolPolicy): void {
  if (name === "bash") {
    const command = isRecord(args) && typeof args.command === "string" ? args.command.trim() : "";
    if (!policy.allowedCommands.includes(command)) {
      throw new Error(`runtime_contract.forbidden_command: ${command || "<missing>"}`);
    }
  }
  visit(args, (key, value) => {
    if (PATH_KEYS.has(key) && typeof value === "string") resolveWorkspacePath(root, value);
  });
  if (name === "apply_patch" && isRecord(args)) {
    const patch = typeof args.patch === "string" ? args.patch : typeof args.input === "string" ? args.input : "";
    for (const match of patch.matchAll(/^\*{3} (?:Add|Update|Delete) File: (.+)$/gm))
      resolveWorkspacePath(root, match[1]!);
    for (const match of patch.matchAll(/^\*{3} Move to: (.+)$/gm)) resolveWorkspacePath(root, match[1]!);
  }
}

function normalizeEvidence(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    const aliasedRoot = process.platform === "darwin" ? `/private${normalizePlatformAlias(root)}` : root;
    return value.split(aliasedRoot).join("$WORKSPACE").split(root).join("$WORKSPACE").slice(0, 16_384);
  }
  if (Array.isArray(value)) return value.map((item) => normalizeEvidence(item, root));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeEvidence(item, root)]));
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
