// @summary Provider auth status carries shared onboarding metadata for every thin client

import { expect, test } from "bun:test";
import { ProviderAuthStatusSchema } from "../src/data-model";

test("ProviderAuthStatusSchema accepts a shared provider descriptor", () => {
  expect(
    ProviderAuthStatusSchema.parse({
      provider: "gemini",
      descriptor: {
        provider: "gemini",
        displayName: "Gemini",
        authMethod: "api_key",
        apiKeyUrl: "https://aistudio.google.com/apikey",
        apiKeyPlaceholder: "AIza...",
      },
      configured: false,
    }),
  ).toMatchObject({ descriptor: { displayName: "Gemini", authMethod: "api_key" } });
});
