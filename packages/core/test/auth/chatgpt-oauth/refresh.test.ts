// @summary Mock tests for OAuth token refresh
import { afterEach, describe, expect, mock, test } from "bun:test";
import { refreshOAuthTokens, shouldRefresh } from "../../../src/auth/chatgpt-oauth/refresh";
import type { OpenAIOAuthTokens } from "../../../src/auth/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const makeTokens = (expiresAt: number): OpenAIOAuthTokens => ({
  access_token: "at",
  refresh_token: "rt",
  id_token: fakeJwt({
    email: "old@example.com",
    chatgpt_account_id: "old-account",
  }),
  expires_at: expiresAt,
  account_id: "old-account",
  account_info: { email: "old@example.com", chatgpt_account_id: "old-account" },
});

function fakeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

describe("shouldRefresh", () => {
  test("returns false when token expires more than 5 minutes from now", () => {
    const tokens = makeTokens(Date.now() + 6 * 60 * 1000);
    expect(shouldRefresh(tokens)).toBe(false);
  });

  test("returns false when token expires exactly 5 minutes from now (boundary)", () => {
    // expires_at - 5min = now → NOT < now → no refresh yet
    const tokens = makeTokens(Date.now() + 5 * 60 * 1000);
    expect(shouldRefresh(tokens)).toBe(false);
  });

  test("returns true when token expires 4 minutes from now", () => {
    const tokens = makeTokens(Date.now() + 4 * 60 * 1000);
    expect(shouldRefresh(tokens)).toBe(true);
  });

  test("returns true when token is already expired", () => {
    const tokens = makeTokens(Date.now() - 1000);
    expect(shouldRefresh(tokens)).toBe(true);
  });
});

describe("refreshOAuthTokens", () => {
  test("accepts an access-token-only refresh response and preserves prior fields", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ access_token: "new-at" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const expiresAt = Date.now() + 60_000;
    const tokens = makeTokens(expiresAt);
    const newTokens = await refreshOAuthTokens(tokens);

    expect(newTokens).toEqual({ ...tokens, access_token: "new-at" });
  });

  test("uses returned expiry while preserving the ID and refresh tokens", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ access_token: "new-at", expires_in: 3600 }), { status: 200 }),
    ) as unknown as typeof fetch;

    const before = Date.now();
    const tokens = makeTokens(before + 60_000);
    const newTokens = await refreshOAuthTokens(tokens);

    expect(newTokens.access_token).toBe("new-at");
    expect(newTokens.refresh_token).toBe(tokens.refresh_token);
    expect(newTokens.id_token).toBe(tokens.id_token);
    expect(newTokens.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  test("accepts a rotated refresh token", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "new-at",
            refresh_token: "new-rt",
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const tokens = makeTokens(Date.now() + 60_000);
    const newTokens = await refreshOAuthTokens(tokens);

    expect(newTokens.access_token).toBe("new-at");
    expect(newTokens.refresh_token).toBe("new-rt");
    expect(newTokens.id_token).toBe(tokens.id_token);
  });

  test("replaces the ID token and recomputes account metadata", async () => {
    const replacementIdToken = fakeJwt({
      email: "new@example.com",
      chatgpt_account_id: "new-account",
    });
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ id_token: replacementIdToken }), { status: 200 }),
    ) as unknown as typeof fetch;

    const tokens = makeTokens(Date.now() + 60_000);
    const newTokens = await refreshOAuthTokens(tokens);

    expect(newTokens.id_token).toBe(replacementIdToken);
    expect(newTokens.account_id).toBe("new-account");
    expect(newTokens.account_info).toEqual({
      email: "new@example.com",
      chatgpt_account_id: "new-account",
    });
  });

  test("preserves a still-usable prior access token when omitted", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ refresh_token: "new-rt" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const tokens = makeTokens(Date.now() + 60_000);
    const newTokens = await refreshOAuthTokens(tokens);

    expect(newTokens.access_token).toBe(tokens.access_token);
    expect(newTokens.refresh_token).toBe("new-rt");
  });

  test("preserves the prior expiry when expires_in is invalid", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ access_token: "new-at", expires_in: "soon" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const expiresAt = Date.now() + 60_000;
    const newTokens = await refreshOAuthTokens(makeTokens(expiresAt));

    expect(newTokens.expires_at).toBe(expiresAt);
  });

  test("rejects a non-object refresh response", async () => {
    globalThis.fetch = mock(async () => new Response("null", { status: 200 })) as unknown as typeof fetch;

    await expect(refreshOAuthTokens(makeTokens(Date.now() + 60_000))).rejects.toThrow(
      "Token refresh response must be an object",
    );
  });

  test.each([null, "", 42])("rejects malformed returned token field %p", async (accessToken) => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ access_token: accessToken }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(refreshOAuthTokens(makeTokens(Date.now() + 60_000))).rejects.toThrow(
      "access_token must be a non-empty string",
    );
  });

  test("rejects a malformed replacement ID token", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ id_token: "not-a-jwt" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(refreshOAuthTokens(makeTokens(Date.now() + 60_000))).rejects.toThrow("id_token must be a valid JWT");
  });

  test("throws on refresh endpoint error", async () => {
    globalThis.fetch = mock(async () => new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;

    const tokens = makeTokens(Date.now() + 60_000);
    await expect(refreshOAuthTokens(tokens)).rejects.toThrow("Token refresh failed (400)");
  });
});
