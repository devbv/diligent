// @summary Separates Studio v2 warnings from failures inside a successful JSON-RPC result.

/**
 * `call()` rejects only on the JSON-RPC envelope's `error`. The instance methods
 * report their own outcome inside `result`, so every v2 response is checked here.
 *
 * `message` holds one entry per affected item, joined by `; `, each prefixed with
 * `[WARNING]` or `[ERROR]`. A warning means Studio completed the write and ignored
 * something (an unknown property, a Mobility set below Workspace); the file backend
 * surfaces the same cases as suggestions rather than failing, so warnings are
 * returned instead of thrown. Anything unprefixed is treated as a failure, since an
 * unrecognised message cannot be assumed harmless.
 */
export interface ResultCheck {
  warnings: string[];
}

function segments(message: string): string[] {
  return message
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export function checkResult(method: string, result: unknown): ResultCheck {
  const payload = result as { success?: unknown; message?: unknown } | null | undefined;
  const message = typeof payload?.message === "string" ? payload.message : "";

  if (payload?.success === false) {
    throw new Error(`${method} failed: ${message.trim() !== "" ? message : "(no message)"}`);
  }
  if (message.trim() === "") return { warnings: [] };

  const parts = segments(message);
  const failures = parts.filter((part) => !part.includes("[WARNING]"));
  if (failures.length > 0) throw new Error(`${method} partial failure: ${failures.join("; ")}`);

  return { warnings: parts };
}
