// @summary Tests the OVERDARE gateway transmitter provider (OVDR-11475 §B, MVP).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { HookInput } from "@diligent/runtime";
import { createGatewayToolProvider } from "../../src/tools/gateway";

const realFetch = globalThis.fetch;
const realUrl = process.env.DILIGENT_GATEWAY_URL;
const realToken = process.env.DILIGENT_GATEWAY_TOKEN;

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
  authorization?: string;
}

function installFetchSpy(): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
      authorization: headers.get("authorization") ?? undefined,
    });
    return new Response(JSON.stringify({ accepted: 1, inserted: 1, duplicates: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "sess-1",
    transcript_path: "/tmp/sess-1.jsonl",
    cwd: "/tmp/project",
    hook_event_name: "EntryAppended",
    user_id: "alice",
    seq: 7,
    entry: {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "2026-06-24T00:00:00.000Z",
      message: { role: "user", content: "my key sk-ant-0123456789012345678901", timestamp: 0 },
    },
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realUrl === undefined) delete process.env.DILIGENT_GATEWAY_URL;
  else process.env.DILIGENT_GATEWAY_URL = realUrl;
  if (realToken === undefined) delete process.env.DILIGENT_GATEWAY_TOKEN;
  else process.env.DILIGENT_GATEWAY_TOKEN = realToken;
});

describe("createGatewayToolProvider", () => {
  beforeEach(() => {
    process.env.DILIGENT_GATEWAY_URL = "http://127.0.0.1:8000";
    process.env.DILIGENT_GATEWAY_TOKEN = "test-token";
  });

  test("registers as an async hook", () => {
    const provider = createGatewayToolProvider({ cwd: "/tmp", projectId: "proj-1" });
    expect(provider.onEntryAppended?.mode).toBe("async");
  });

  test("POSTs a valid masked envelope on append", async () => {
    const calls = installFetchSpy();
    const provider = createGatewayToolProvider({ cwd: "/tmp", projectId: "proj-1" });

    await provider.onEntryAppended?.(makeInput());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8000/v1/records");
    expect(calls[0].authorization).toBe("Bearer test-token");

    const env = calls[0].body;
    expect(env.project_id).toBe("proj-1");
    expect(env.user_id).toBe("alice");
    expect(env.session_id).toBe("sess-1");
    expect(env.seq).toBe(7);
    expect(env.event_ts).toBe("2026-06-24T00:00:00.000Z");
    // Secret in the record is masked before transmit.
    expect(JSON.stringify(env.record)).toContain("[REDACTED:anthropic-key]");
  });

  test("does not POST when no token is configured", async () => {
    delete process.env.DILIGENT_GATEWAY_TOKEN;
    const calls = installFetchSpy();
    const provider = createGatewayToolProvider({ cwd: "/tmp", projectId: "proj-1" });

    await provider.onEntryAppended?.(makeInput());

    expect(calls).toHaveLength(0);
  });

  test("does not POST when no projectId is provided", async () => {
    const calls = installFetchSpy();
    const provider = createGatewayToolProvider({ cwd: "/tmp" });

    await provider.onEntryAppended?.(makeInput());

    expect(calls).toHaveLength(0);
  });
});
