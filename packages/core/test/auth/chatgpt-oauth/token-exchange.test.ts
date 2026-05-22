// @summary Tests for OpenAI token exchange: code exchange, JWT parsing, account_id extraction
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  buildOAuthTokens,
  exchangeCodeForTokens,
  extractAccountId,
  extractAccountInfo,
  parseJwtClaims,
  type RawTokenResponse,
} from "../../../src/auth/chatgpt-oauth/token-exchange";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build a fake JWT with the given payload (unsigned — for testing only) */
function fakeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

describe("exchangeCodeForTokens", () => {
  test("returns token response on success", async () => {
    const mockResponse = {
      access_token: "at-123",
      refresh_token: "rt-456",
      id_token: "it-789",
      expires_in: 3600,
      token_type: "Bearer",
    };

    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(mockResponse), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await exchangeCodeForTokens("auth-code", "verifier");
    expect(result.access_token).toBe("at-123");
    expect(result.refresh_token).toBe("rt-456");
    expect(result.id_token).toBe("it-789");
    expect(result.expires_in).toBe(3600);
  });

  test("throws on HTTP error", async () => {
    globalThis.fetch = mock(async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;

    await expect(exchangeCodeForTokens("bad-code", "verifier")).rejects.toThrow("Token exchange failed (401)");
  });
});

describe("parseJwtClaims", () => {
  test("returns claims from valid JWT", () => {
    const payload = { chatgpt_account_id: "acc-123", email: "test@example.com" };
    const claims = parseJwtClaims(fakeJwt(payload));
    expect(claims?.chatgpt_account_id).toBe("acc-123");
  });

  test("returns undefined for non-JWT string", () => {
    expect(parseJwtClaims("not-a-jwt")).toBeUndefined();
    expect(parseJwtClaims("only.two")).toBeUndefined();
  });

  test("returns undefined for invalid base64 payload", () => {
    expect(parseJwtClaims("header.!!!.sig")).toBeUndefined();
  });
});

describe("extractAccountId", () => {
  test("extracts chatgpt_account_id from id_token", () => {
    const raw = {
      access_token: fakeJwt({ sub: "user-1" }),
      refresh_token: "rt",
      id_token: fakeJwt({ chatgpt_account_id: "acc-from-id-token" }),
      expires_in: 3600,
      token_type: "Bearer",
    };
    expect(extractAccountId(raw)).toBe("acc-from-id-token");
  });

  test("extracts from nested https://api.openai.com/auth claim", () => {
    const raw = {
      access_token: fakeJwt({ sub: "user-1" }),
      refresh_token: "rt",
      id_token: fakeJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }),
      expires_in: 3600,
      token_type: "Bearer",
    };
    expect(extractAccountId(raw)).toBe("acc-nested");
  });

  test("falls back to organizations[0].id", () => {
    const raw = {
      access_token: fakeJwt({ sub: "user-1" }),
      refresh_token: "rt",
      id_token: fakeJwt({ organizations: [{ id: "org-abc" }] }),
      expires_in: 3600,
      token_type: "Bearer",
    };
    expect(extractAccountId(raw)).toBe("org-abc");
  });

  test("falls back to access_token when id_token has no account_id", () => {
    const raw = {
      access_token: fakeJwt({ chatgpt_account_id: "acc-from-access" }),
      refresh_token: "rt",
      id_token: fakeJwt({ sub: "no-account-id" }),
      expires_in: 3600,
      token_type: "Bearer",
    };
    expect(extractAccountId(raw)).toBe("acc-from-access");
  });

  test("returns undefined when no account_id found", () => {
    const raw = {
      access_token: fakeJwt({ sub: "user-1" }),
      refresh_token: "rt",
      id_token: fakeJwt({ sub: "user-1" }),
      expires_in: 3600,
      token_type: "Bearer",
    };
    expect(extractAccountId(raw)).toBeUndefined();
  });
});

describe("extractAccountInfo", () => {
  test("extracts email and ChatGPT subscription claims from id_token", () => {
    const raw = {
      access_token: fakeJwt({
        email: "access-token@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "free" },
      }),
      refresh_token: "rt",
      id_token: fakeJwt({
        email: "test@example.com",
        "https://api.openai.com/auth": {
          chatgpt_plan_type: "pro",
          chatgpt_user_id: "user-123",
          chatgpt_account_id: "acc-123",
          chatgpt_account_is_fedramp: false,
        },
      }),
      expires_in: 3600,
      token_type: "Bearer",
    };

    expect(extractAccountInfo(raw)).toEqual({
      email: "test@example.com",
      chatgpt_plan_type: "pro",
      chatgpt_user_id: "user-123",
      chatgpt_account_id: "acc-123",
      chatgpt_account_is_fedramp: false,
    });
  });

  test("returns undefined when id_token has no account metadata", () => {
    const raw = {
      access_token: fakeJwt({
        email: "access-token@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
      }),
      refresh_token: "rt",
      id_token: fakeJwt({ sub: "user-1" }),
      expires_in: 3600,
      token_type: "Bearer",
    };

    expect(extractAccountInfo(raw)).toBeUndefined();
  });
});

describe("buildOAuthTokens", () => {
  test("builds tokens with expires_at from expires_in", () => {
    const before = Date.now();
    const raw = {
      access_token: fakeJwt({ chatgpt_account_id: "acc-build" }),
      refresh_token: "rt",
      id_token: fakeJwt({ sub: "u" }),
      expires_in: 3600,
      token_type: "Bearer",
    };

    const tokens = buildOAuthTokens(raw);
    const after = Date.now();

    expect(tokens.access_token).toBe(raw.access_token);
    expect(tokens.refresh_token).toBe("rt");
    expect(tokens.account_id).toBe("acc-build");
    expect(tokens.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expires_at).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  test("defaults expires_in to 3600 when missing", () => {
    const before = Date.now();
    const raw = {
      access_token: "at",
      refresh_token: "rt",
      id_token: "it.e30.sig", // minimal valid-ish jwt with empty payload
      token_type: "Bearer",
    } as RawTokenResponse;

    const tokens = buildOAuthTokens(raw);
    expect(tokens.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  test("includes account metadata from id_token claims", () => {
    const raw = {
      access_token: "at",
      refresh_token: "rt",
      id_token: fakeJwt({
        email: "test@example.com",
        "https://api.openai.com/auth": {
          chatgpt_plan_type: "plus",
          chatgpt_user_id: "user-build",
          chatgpt_account_id: "acc-build",
          chatgpt_account_is_fedramp: true,
        },
      }),
      token_type: "Bearer",
    } as RawTokenResponse;

    const tokens = buildOAuthTokens(raw);
    expect(tokens.account_id).toBe("acc-build");
    expect(tokens.account_info).toEqual({
      email: "test@example.com",
      chatgpt_plan_type: "plus",
      chatgpt_user_id: "user-build",
      chatgpt_account_id: "acc-build",
      chatgpt_account_is_fedramp: true,
    });
  });
});
