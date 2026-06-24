// @summary Tests the gateway 1st-pass secret masking (OVDR-11475 §C).

import { describe, expect, test } from "bun:test";
import { maskString, maskValue } from "../../src/tools/gateway/masking";

describe("maskString", () => {
  test("redacts common secret shapes", () => {
    expect(maskString("key AKIAIOSFODNN7EXAMPLE here")).toContain("[REDACTED:aws-access-key]");
    expect(maskString("ghp_0123456789012345678901234567890123456789")).toContain("[REDACTED:github-token]");
    expect(maskString("token sk-ant-0123456789012345678901")).toContain("[REDACTED:anthropic-key]");
    expect(maskString("token sk-0123456789012345678901")).toContain("[REDACTED:openai-key]");
    expect(maskString("Authorization: Bearer abcdef0123456789")).toContain("[REDACTED:bearer]");
  });

  test("anthropic key is matched as anthropic, not openai", () => {
    const out = maskString("sk-ant-0123456789012345678901");
    expect(out).toContain("[REDACTED:anthropic-key]");
    expect(out).not.toContain("[REDACTED:openai-key]");
  });

  test("leaves ordinary text untouched", () => {
    expect(maskString("the quick brown fox")).toBe("the quick brown fox");
  });
});

describe("maskValue", () => {
  test("masks string values deep while preserving structure and keys", () => {
    const input = {
      type: "message",
      message: {
        role: "user",
        content: "my key is ghp_0123456789012345678901234567890123456789",
        nested: ["plain", "AKIAIOSFODNN7EXAMPLE"],
      },
    };
    const out = maskValue(input);

    // Structure / keys / enum values preserved.
    expect(out.type).toBe("message");
    expect(out.message.role).toBe("user");
    // Secrets in string values redacted.
    expect(out.message.content).toContain("[REDACTED:github-token]");
    expect(out.message.nested[0]).toBe("plain");
    expect(out.message.nested[1]).toContain("[REDACTED:aws-access-key]");
    // Original object not mutated.
    expect(input.message.nested[1]).toBe("AKIAIOSFODNN7EXAMPLE");
  });

  test("passes non-string scalars through unchanged", () => {
    const input = { seq: 3, ok: true, nothing: null };
    expect(maskValue(input)).toEqual({ seq: 3, ok: true, nothing: null });
  });
});
