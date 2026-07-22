// @summary Tests local eval ChatGPT OAuth lifecycle, retry bounds, and production provider binding
import { describe, expect, test } from "bun:test";
import type { OpenAIOAuthTokens } from "@diligent/core/auth";
import { EventStream } from "@diligent/core/event-stream";
import type { AssistantMessage } from "@diligent/core/message-contract";
import {
  type Model,
  ProviderError,
  ProviderErrorType,
  type ProviderEvent,
  ProviderManager,
  type ProviderResult,
  type StreamFunction,
} from "@diligent/core/provider-contract";
import { ChatGPTEvalAuth, isClearChatGPTAuthenticationFailure } from "../../src/providers/chatgpt-oauth";

const MODEL: Model = {
  provider: "chatgpt",
  modelId: "gpt-5.5",
  contextWindow: 300_000,
  maxOutputTokens: 128_000,
  supportsThinking: true,
};

function tokens(label: string, expiresAt = Date.now() + 60 * 60 * 1000): OpenAIOAuthTokens {
  return {
    access_token: `access-${label}`,
    refresh_token: `refresh-${label}`,
    id_token: `id-${label}`,
    expires_at: expiresAt,
    account_id: `account-${label}`,
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: { provider: "chatgpt", modelId: MODEL.modelId },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function doneStream(text: string): ReturnType<StreamFunction> {
  const stream = new EventStream<ProviderEvent, ProviderResult>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return { message: event.message };
      if (event.type === "error") throw event.error;
      throw new Error("missing terminal event");
    },
  );
  stream.push({ type: "done", stopReason: "end_turn", message: assistant(text) });
  return stream;
}

function errorStream(error: Error): ReturnType<StreamFunction> {
  const stream = new EventStream<ProviderEvent, ProviderResult>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return { message: event.message };
      if (event.type === "error") throw event.error;
      throw new Error("missing terminal event");
    },
  );
  stream.push({ type: "error", error });
  return stream;
}

function unterminatedStream(): ReturnType<StreamFunction> {
  const stream = new EventStream<ProviderEvent, ProviderResult>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return { message: event.message };
      if (event.type === "error") throw event.error;
      throw new Error("missing terminal event");
    },
  );
  stream.end({ message: assistant("not delivered") });
  return stream;
}

describe("ChatGPTEvalAuth", () => {
  test("logs in with the shared browser OAuth flow and persists missing credentials", async () => {
    const events: string[] = [];
    const loggedIn = tokens("login");
    const auth = new ChatGPTEvalAuth({
      load: async () => undefined,
      save: async (value) => {
        events.push(`save:${value.access_token}`);
      },
      refresh: async () => {
        throw new Error("refresh should not run");
      },
      login: async () => {
        events.push("login");
        return loggedIn;
      },
      shouldRefresh: () => false,
      createStream: () => () => doneStream("ok"),
      createNativeCompaction: () => async () => ({ status: "unsupported" }),
    });

    await auth.initialize();

    expect(events).toEqual(["login", "save:access-login"]);
    expect(auth.redactionSecrets()).toEqual([
      loggedIn.access_token,
      loggedIn.refresh_token,
      loggedIn.id_token,
      loggedIn.account_id!,
    ]);
  });

  test("refreshes near-expiry credentials and persists rotation before provider use", async () => {
    const events: string[] = [];
    const stale = tokens("stale", Date.now());
    const refreshed = tokens("refreshed");
    const auth = new ChatGPTEvalAuth({
      load: async () => stale,
      save: async (value) => {
        events.push(`save:${value.access_token}`);
      },
      refresh: async (value) => {
        events.push(`refresh:${value.access_token}`);
        return refreshed;
      },
      login: async () => {
        throw new Error("login should not run");
      },
      shouldRefresh: (value) => value === stale,
      createStream: () => () => doneStream("ok"),
      createNativeCompaction: () => async () => ({ status: "unsupported" }),
    });

    await auth.initialize();
    const result = await auth.streamFunction(MODEL, { systemPrompt: [], messages: [], tools: [] }, {}).result();

    expect(result.message.content).toEqual([{ type: "text", text: "ok" }]);
    expect(events).toEqual(["refresh:access-stale", "save:access-refreshed"]);
  });

  test("allows one interactive re-login and retries a clearly rejected stream once", async () => {
    const initial = tokens("initial");
    const replacement = tokens("replacement");
    const attempts: string[] = [];
    const registeredSecrets: string[] = [];
    let logins = 0;
    const auth = new ChatGPTEvalAuth({
      load: async () => initial,
      save: async () => {},
      refresh: async (value) => value,
      login: async () => {
        logins += 1;
        return replacement;
      },
      shouldRefresh: () => false,
      createStream: (getTokens) => () => {
        attempts.push(getTokens().access_token);
        return attempts.length === 1
          ? errorStream(
              new ProviderError("rejected", {
                errorType: ProviderErrorType.Auth,
                isRetryable: false,
                statusCode: 401,
              }),
            )
          : doneStream("recovered");
      },
      createNativeCompaction: () => async () => ({ status: "unsupported" }),
      onCredentials: (value) => registeredSecrets.push(value.access_token),
    });
    await auth.initialize();

    const result = await auth.streamFunction(MODEL, { systemPrompt: [], messages: [], tools: [] }, {}).result();

    expect(result.message.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(attempts).toEqual([initial.access_token, replacement.access_token]);
    expect(registeredSecrets).toEqual([initial.access_token, replacement.access_token]);
    expect(logins).toBe(1);
  });

  test("does not re-login for network failures", async () => {
    let logins = 0;
    const failure = new ProviderError("offline", {
      errorType: ProviderErrorType.Network,
      isRetryable: true,
    });
    const auth = new ChatGPTEvalAuth({
      load: async () => tokens("initial"),
      save: async () => {},
      refresh: async (value) => value,
      login: async () => {
        logins += 1;
        return tokens("replacement");
      },
      shouldRefresh: () => false,
      createStream: () => () => errorStream(failure),
      createNativeCompaction: () => async () => ({ status: "unsupported" }),
    });
    await auth.initialize();

    await expect(auth.streamFunction(MODEL, { systemPrompt: [], messages: [], tools: [] }, {}).result()).rejects.toBe(
      failure,
    );
    expect(logins).toBe(0);
  });

  test("never performs a second interactive re-login after another authentication rejection", async () => {
    let attempts = 0;
    let logins = 0;
    const rejected = new ProviderError("rejected", {
      errorType: ProviderErrorType.Auth,
      isRetryable: false,
      statusCode: 401,
    });
    const auth = new ChatGPTEvalAuth({
      load: async () => tokens("initial"),
      save: async () => {},
      refresh: async (value) => value,
      login: async () => {
        logins += 1;
        return tokens("replacement");
      },
      shouldRefresh: () => false,
      createStream: () => () => {
        attempts += 1;
        return errorStream(rejected);
      },
      createNativeCompaction: () => async () => ({ status: "unsupported" }),
    });
    await auth.initialize();

    await expect(auth.streamFunction(MODEL, { systemPrompt: [], messages: [], tools: [] }, {}).result()).rejects.toBe(
      rejected,
    );
    expect(attempts).toBe(2);
    expect(logins).toBe(1);
  });

  test("fails instead of hanging when the provider stream ends without a terminal event", async () => {
    const auth = new ChatGPTEvalAuth({
      load: async () => tokens("initial"),
      save: async () => {},
      refresh: async (value) => value,
      login: async () => tokens("replacement"),
      shouldRefresh: () => false,
      createStream: () => () => unterminatedStream(),
      createNativeCompaction: () => async () => ({ status: "unsupported" }),
    });
    await auth.initialize();

    await expect(
      auth.streamFunction(MODEL, { systemPrompt: [], messages: [], tools: [] }, {}).result(),
    ).rejects.toThrow("ended without a terminal event");
  });

  test("binds the authenticated production native-compaction path into ProviderManager", async () => {
    const initial = tokens("initial");
    let compactToken = "";
    const auth = new ChatGPTEvalAuth({
      load: async () => initial,
      save: async () => {},
      refresh: async (value) => value,
      login: async () => tokens("replacement"),
      shouldRefresh: () => false,
      createStream: () => () => doneStream("ok"),
      createNativeCompaction: (getTokens) => async () => {
        compactToken = getTokens().access_token;
        return { status: "ok", compactionSummary: { type: "compaction_summary", encrypted_content: "opaque" } };
      },
    });
    await auth.initialize();
    const manager = new ProviderManager({});
    auth.bindProviderManager(manager);

    const compact = manager.createNativeCompactionForProvider("chatgpt");
    const result = await compact!({ model: MODEL, systemPrompt: [], messages: [] });

    expect(result.status).toBe("ok");
    expect(compactToken).toBe(initial.access_token);
  });
});

test("clear authentication classification excludes non-auth failures", () => {
  expect(isClearChatGPTAuthenticationFailure(new Error("ChatGPT native compaction failed (401)"))).toBe(true);
  expect(isClearChatGPTAuthenticationFailure(new Error('Token refresh failed (400): {"error":"invalid_grant"}'))).toBe(
    true,
  );
  expect(isClearChatGPTAuthenticationFailure(new Error("ChatGPT native compaction failed (400)"))).toBe(false);
  expect(isClearChatGPTAuthenticationFailure(new TypeError("fetch failed"))).toBe(false);
});
