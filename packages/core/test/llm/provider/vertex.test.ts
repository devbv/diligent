// @summary Tests for Vertex OpenAI-compatible model id resolution
import { describe, expect, it } from "bun:test";
import { classifyVertexError, resolveVertexModelId } from "../../../src/llm/provider/vertex";
import { ProviderErrorType } from "../../../src/llm/types";

describe("resolveVertexModelId", () => {
  it("maps the internal Vertex Gemma model to the MAAS publisher model on openapi", () => {
    const resolved = resolveVertexModelId(
      "vertex-gemma-4-26b-it",
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo/locations/us-central1/endpoints/openapi",
    );

    expect(resolved).toBe("google/gemma-4-26b-a4b-it-maas");
  });

  it("prefers explicit modelMap overrides over the built-in openapi mapping", () => {
    const resolved = resolveVertexModelId(
      "vertex-gemma-4-26b-it",
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo/locations/us-central1/endpoints/openapi",
      { "vertex-gemma-4-26b-it": "custom/publisher-model" },
    );

    expect(resolved).toBe("custom/publisher-model");
  });

  it("keeps the internal model id for non-openapi endpoints", () => {
    const resolved = resolveVertexModelId(
      "vertex-gemma-4-26b-it",
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo/locations/us-central1/endpoints/1234567890",
    );

    expect(resolved).toBe("vertex-gemma-4-26b-it");
  });
});

describe("classifyVertexError", () => {
  it("recognizes AI SDK statusCode errors", () => {
    expect(classifyVertexError(Object.assign(new Error("unavailable"), { statusCode: 503 }))).toMatchObject({
      errorType: ProviderErrorType.ServerError,
      isRetryable: true,
    });
  });
});
