// @summary Release-env helper for plugins running inside the OVERDARE runtime.
//
// `currentEnv()` reads the `DILIGENT_ENV` environment variable that the
// overdare-ai-agent launcher forwards to its runtime child process. It returns
// either `"prod"` or `"dev"`, defaulting to `"prod"` when the variable is
// missing, empty, or unrecognized (e.g. an older launcher that does not set
// it).
//
// When NOT to use this:
//   This signal reflects the build channel the *agent binary* was published
//   under — not which Overdare deployment the user is talking to. Backing
//   services tied to a deployment (analytics destination, hub-side data
//   sources) should keep keying off `HUB_DOMAIN` instead, since QA can connect
//   a prod-channel agent to a non-prod hub.
//
// When TO use this:
//   For services or behavior that scale with the agent's release channel —
//   e.g. dev-only diagnostics, telemetry that flags pre-release builds, or
//   future dev-only feature gates.

export type Env = "prod" | "dev";

/**
 * Returns the release env that the agent is running under.
 *
 * Source of truth: the `DILIGENT_ENV` environment variable, set by the
 * overdare-ai-agent launcher on every spawn of the runtime child process.
 *
 * Returns `"prod"` when the variable is unset, empty, or any value other than
 * `"dev"` (case-insensitive). This conservative default keeps legacy
 * launchers — and any non-OVERDARE runtime host — on the prod codepath.
 */
export function currentEnv(): Env {
  const raw = process.env.DILIGENT_ENV?.trim().toLowerCase();
  return raw === "dev" ? "dev" : "prod";
}
