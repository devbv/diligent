// @summary Subprocess guardrails for the Luau procedural runner.

/** Bounds applied to every Luau procedural subprocess and its I/O. */
export interface ProceduralLimits {
  /** Max wall-clock time before the Luau child is killed. */
  timeoutMs: number;
  /** Max bytes of captured stdout/stderr before the child is aborted. */
  maxOutputBytes: number;
  /** Max number of serialized nodes accepted from a single run. */
  maxNodes: number;
  /**
   * Max bytes of the argv-encoded input payload.
   *
   * The vendored Luau 0.723 CLI is sandboxed — it exposes no `io`, no stdin
   * reader, and `require` cannot reach paths outside the project root — so the
   * only viable transport is `--program-args`. `ARG_MAX` is ~1 MiB on the
   * platforms we target; this cap keeps us well under it and turns a would-be
   * cryptic `E2BIG` spawn failure into an actionable error.
   */
  maxInputBytes: number;
}

export const DEFAULT_PROCEDURAL_LIMITS: ProceduralLimits = {
  timeoutMs: 15_000,
  maxOutputBytes: 16 * 1024 * 1024,
  maxNodes: 20_000,
  maxInputBytes: 512 * 1024,
};

export function resolveLimits(overrides?: Partial<ProceduralLimits>): ProceduralLimits {
  return { ...DEFAULT_PROCEDURAL_LIMITS, ...overrides };
}

/** Throws an actionable error if the argv-encoded input would risk `ARG_MAX`. */
export function assertInputWithinArgvLimit(encoded: string, limits: ProceduralLimits): void {
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > limits.maxInputBytes) {
    throw new Error(
      `Procedural script input is ${bytes} bytes, which exceeds the ${limits.maxInputBytes}-byte transport limit. ` +
        "Reduce the script size (or split the generation) — the Luau runner receives its input via command-line " +
        "arguments and larger payloads risk overflowing the OS argument limit.",
    );
  }
}

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
