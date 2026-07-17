// @summary Shared OpenAI-family native compaction error-body formatting

const MAX_ERROR_BODY_LENGTH = 400;

function truncateErrorBody(value: string): string {
  if (value.length <= MAX_ERROR_BODY_LENGTH) return value;
  return `${value.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}

function stringifyErrorPayload(payload: Record<string, unknown>, fields: readonly string[]): string {
  const errorValue = payload.error;
  if (typeof errorValue === "string") return truncateErrorBody(errorValue);
  if (errorValue && typeof errorValue === "object") {
    const error = errorValue as Record<string, unknown>;
    const values = fields.flatMap((field) => (typeof error[field] === "string" ? [error[field]] : []));
    if (values.length > 0) return truncateErrorBody(values.join(" | "));
  }
  return truncateErrorBody(JSON.stringify(payload));
}

export async function readOpenAIFamilyCompactErrorBody(response: Response, fields: readonly string[]): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as unknown;
      if (payload && typeof payload === "object") {
        return stringifyErrorPayload(payload as Record<string, unknown>, fields);
      }
    } catch {
      // Fall through to the text path.
    }
  }

  const text = await response.text().catch(() => "");
  return truncateErrorBody(text.trim());
}
