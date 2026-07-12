// @summary Tests for Diligent protocol JSON-RPC lite envelope schemas
import { describe, expect, it } from "bun:test";
import {
  DiligentClientRequestSchema,
  JSONRPCErrorResponseSchema,
  JSONRPCMessageSchema,
  JSONRPCNotificationSchema,
  JSONRPCRequestSchema,
  JSONRPCResponseSchema,
} from "../src";

describe("protocol/jsonrpc", () => {
  it("accepts request without jsonrpc field (lite)", () => {
    const result = JSONRPCRequestSchema.safeParse({
      id: "req-1",
      method: "turn/start",
      params: { message: "hello" },
    });

    expect(result.success).toBe(true);
  });

  it("accepts notifications without id", () => {
    const result = JSONRPCNotificationSchema.safeParse({
      method: "thread/started",
      params: { threadId: "th-1" },
    });

    expect(result.success).toBe(true);
  });

  it("accepts success and error responses", () => {
    expect(
      JSONRPCResponseSchema.safeParse({
        id: 1,
        result: { ok: true },
      }).success,
    ).toBe(true);

    expect(
      JSONRPCErrorResponseSchema.safeParse({
        id: 1,
        error: { code: -32000, message: "boom" },
      }).success,
    ).toBe(true);
  });

  it("keeps the error field when parsing an error response as a message", () => {
    // Regression: `result: z.unknown()` is optional, so an error response used to match the
    // success schema first and lose its `error` field, leaving `{ id }` — which the client
    // treats as neither a response nor a request and drops, hanging the caller forever.
    const parsed = JSONRPCMessageSchema.parse({
      id: 7,
      error: { code: -32602, message: "Invalid API key" },
    });

    expect("error" in parsed).toBe(true);
    expect("result" in parsed).toBe(false);
  });

  it("rejects malformed message envelope", () => {
    const result = JSONRPCMessageSchema.safeParse({
      params: {},
    });

    expect(result.success).toBe(false);
  });

  it("accepts product experiment list and set requests", () => {
    expect(DiligentClientRequestSchema.safeParse({ method: "experiments/list", params: {} }).success).toBe(true);
    expect(
      DiligentClientRequestSchema.safeParse({
        method: "experiments/set",
        params: { overrides: { procedural: true } },
      }).success,
    ).toBe(true);
  });
});
