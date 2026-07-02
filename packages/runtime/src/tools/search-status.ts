// @summary Structured status helpers for search tool contract failures

import type { ToolResult } from "@diligent/core/tool/types";
import { createTextRenderPayload } from "./render-payload";

export type SearchScopeStatus =
  | {
      kind: "invalid_scope";
      code: "filesystem_root";
      path: string;
      retryable: false;
      actionable: true;
    }
  | {
      kind: "invalid_scope";
      code: "relative_path";
      path: string;
      retryable: false;
      actionable: true;
    }
  | {
      kind: "invalid_scope";
      code: "absolute_pattern";
      pattern: string;
      path: string;
      suggestion: string;
      retryable: false;
      actionable: true;
    };

export function createSearchScopeErrorResult(output: string, status: SearchScopeStatus): ToolResult {
  return {
    output,
    render: createTextRenderPayload(undefined, output, true),
    metadata: { error: true, status },
  };
}
