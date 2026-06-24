// @summary Simple regex-based 1st-pass secret masking for gateway transmission (OVDR-11475 §C).
//
// Deliberately minimal: a flat list of high-confidence secret patterns, each match replaced
// with `[REDACTED:<id>]`. We walk string values only (structure/keys preserved). This mirrors
// the "match"-strategy rules of the diligent-gateway contract (version `secrets-2`); the gateway
// server re-runs its full ruleset (incl. PII) as a catch-all, so the client stays simple.

export const MASKING_VERSION = "secrets-2";

interface MaskPattern {
  id: string;
  regex: RegExp;
}

// Order matters: anthropic-key must run before openai-key (sk-ant- vs sk-).
const PATTERNS: MaskPattern[] = [
  { id: "aws-access-key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", regex: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g },
  { id: "slack-token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { id: "anthropic-key", regex: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/g },
  { id: "openai-key", regex: /\bsk-(?!ant-)[0-9A-Za-z_-]{20,}\b/g },
  { id: "jwt", regex: /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/g },
  {
    id: "private-key-block",
    regex: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  },
  { id: "bearer", regex: /\bBearer\s+[0-9A-Za-z._~+/=-]{12,}/g },
];

/** Redact secrets in a single string. */
export function maskString(input: string): string {
  let out = input;
  for (const { id, regex } of PATTERNS) {
    out = out.replace(regex, `[REDACTED:${id}]`);
  }
  return out;
}

/** Deep-copy a JSON-ish value, masking every string value. Object keys and structure preserved. */
export function maskValue<T>(value: T): T {
  if (typeof value === "string") return maskString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => maskValue(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskValue(val);
    }
    return out as T;
  }
  return value;
}
