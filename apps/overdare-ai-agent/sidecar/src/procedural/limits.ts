// @summary Subprocess guardrails for the Luau procedural runner.

/** Bounds applied to every Luau procedural subprocess and its I/O. */
export interface ProceduralLimits {
  /** Max wall-clock time before the Luau child is killed. */
  timeoutMs: number;
  /** Max bytes of captured stdout/stderr before the child is aborted. */
  maxOutputBytes: number;
  /** Max number of freshly generated nodes accepted from a single run. */
  maxNodes: number;
  /** Optional cap for temporary-file input bytes; omitted by default. */
  maxInputBytes?: number;
}

export const DEFAULT_PROCEDURAL_LIMITS: ProceduralLimits = {
  timeoutMs: 15_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxNodes: 5_000,
};

export function resolveLimits(overrides?: Partial<ProceduralLimits>): ProceduralLimits {
  return { ...DEFAULT_PROCEDURAL_LIMITS, ...overrides };
}

/** Throws when a caller explicitly configured a serialized-input byte limit. */
export function assertInputWithinLimit(encoded: string, limits: ProceduralLimits, additionalBytes = 0): void {
  if (limits.maxInputBytes === undefined) return;
  const bytes = Buffer.byteLength(encoded, "utf8") + additionalBytes;
  if (bytes > limits.maxInputBytes) {
    throw new Error(
      `Procedural input is ${bytes} bytes, which exceeds the configured ${limits.maxInputBytes}-byte input limit.`,
    );
  }
}

/** @deprecated Input is no longer argv-encoded. Use {@link assertInputWithinLimit}. */
export const assertInputWithinArgvLimit = assertInputWithinLimit;

export interface CapturedLuauResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function captureCapped(
  stream: ReadableStream<Uint8Array> | undefined,
  cap: number,
  onOverflow: () => void,
): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (total > cap) {
        onOverflow();
        break;
      }
    }
  } catch {
    // The stream was torn down by a kill(); whatever we buffered is enough.
  }
  text += decoder.decode();
  return text;
}

/**
 * Spawn the Luau runner with timeout + output-size guardrails.
 *
 * Enforces {@link ProceduralLimits.timeoutMs} by killing the child, and
 * {@link ProceduralLimits.maxOutputBytes} across each captured stream. Throws a
 * descriptive error when either bound trips; otherwise returns the captured I/O.
 */
export async function spawnLuauCaptured(
  luauBin: string,
  args: string[],
  options: { cwd: string; limits: ProceduralLimits },
): Promise<CapturedLuauResult> {
  const { cwd, limits } = options;
  const proc = Bun.spawn([luauBin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });

  let timedOut = false;
  let overflowed = false;
  const kill = () => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, limits.timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      captureCapped(proc.stdout as ReadableStream<Uint8Array> | undefined, limits.maxOutputBytes, () => {
        overflowed = true;
        kill();
      }),
      captureCapped(proc.stderr as ReadableStream<Uint8Array> | undefined, limits.maxOutputBytes, () => {
        overflowed = true;
        kill();
      }),
      proc.exited,
    ]);

    if (timedOut) {
      throw new Error(`Procedural Luau runner timed out after ${limits.timeoutMs}ms.`);
    }
    if (overflowed) {
      throw new Error(`Procedural Luau runner exceeded the ${limits.maxOutputBytes}-byte output limit.`);
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

interface CountableNode {
  guid?: string;
  children?: CountableNode[];
}

const MAX_NODE_DEPTH = 64;

/** Counts every node in a serialized tree, guarding against runaway depth. */
export function countTreeNodes(nodes: CountableNode[], depth = 1): number {
  if (depth > MAX_NODE_DEPTH) {
    throw new Error(`Procedural output exceeds the maximum tree depth of ${MAX_NODE_DEPTH}.`);
  }
  let count = 0;
  for (const node of nodes) {
    count += 1 + countTreeNodes(node.children ?? [], depth + 1);
  }
  return count;
}

/** Throws if the serialized tree has more nodes than {@link ProceduralLimits.maxNodes}. */
export function assertNodeCountWithinLimit(nodes: CountableNode[], limits: ProceduralLimits): number {
  const count = countTreeNodes(nodes);
  if (count > limits.maxNodes) {
    throw new Error(`Procedural output contains ${count} nodes, which exceeds the maximum of ${limits.maxNodes}.`);
  }
  return count;
}

/** Counts only fresh nodes; injected scene nodes carry GUIDs and do not consume generation budget. */
export function countGeneratedTreeNodes(nodes: CountableNode[], depth = 1): number {
  if (depth > MAX_NODE_DEPTH) {
    throw new Error(`Procedural output exceeds the maximum tree depth of ${MAX_NODE_DEPTH}.`);
  }
  let count = 0;
  for (const node of nodes) {
    count += (node.guid === undefined ? 1 : 0) + countGeneratedTreeNodes(node.children ?? [], depth + 1);
  }
  return count;
}

/** Throws when freshly generated nodes exceed the run's node budget. */
export function assertGeneratedNodeCountWithinLimit(nodes: CountableNode[], limits: ProceduralLimits): number {
  const count = countGeneratedTreeNodes(nodes);
  if (count > limits.maxNodes) {
    throw new Error(`Procedural output generates ${count} nodes, which exceeds the maximum of ${limits.maxNodes}.`);
  }
  return count;
}
