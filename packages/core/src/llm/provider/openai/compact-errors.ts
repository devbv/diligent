// @summary Shared OpenAI-family native compaction error-body formatting

const MAX_ERROR_BODY_LENGTH = 400;

export interface OpenAIFamilyCompactErrorBody {
  formatted: string;
  code?: string;
  type?: string;
  param?: string;
  message?: string;
}

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
  return (await readOpenAIFamilyCompactError(response, fields)).formatted;
}

export async function readOpenAIFamilyCompactError(
  response: Response,
  fields: readonly string[],
): Promise<OpenAIFamilyCompactErrorBody> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as unknown;
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        const rawError = record.error;
        const error = rawError && typeof rawError === "object" ? (rawError as Record<string, unknown>) : undefined;
        return {
          formatted: stringifyErrorPayload(record, fields),
          ...readStringFields(error),
        };
      }
    } catch {
      // Fall through to the text path.
    }
  }

  const text = await response.text().catch(() => "");
  return { formatted: truncateErrorBody(text.trim()) };
}

function readStringFields(error: Record<string, unknown> | undefined): Omit<OpenAIFamilyCompactErrorBody, "formatted"> {
  if (!error) return {};
  return {
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.type === "string" ? { type: error.type } : {}),
    ...(typeof error.param === "string" ? { param: error.param } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {}),
  };
}
