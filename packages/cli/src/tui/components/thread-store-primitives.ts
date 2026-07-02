// @summary Shared ThreadStore item primitives and view wrappers for TUI transcript rendering

import type { ToolResultStatus } from "@diligent/protocol";
import { t } from "../theme";

export class UserMessageView {
  constructor(private text: string) {}

  render(_width: number): string[] {
    return [`${t.bgUser}${t.bold}${t.dim}❯${t.reset}${t.bgUser} ${this.text}${t.reset}`];
  }

  invalidate(): void {}
}

export type ThreadItem =
  | {
      kind: "plain";
      lines: string[];
      separateBefore?: boolean;
    }
  | {
      kind: "assistant_chunk";
      text: string;
      continued: boolean;
    }
  | {
      kind: "tool_result";
      header: string;
      summaryLine?: string;
      details: string[];
      childDetail?: {
        childThreadId: string;
        status: "idle" | "loading" | "loaded" | "error";
        lines?: string[];
        error?: string;
      };
      resultStatus?: ToolResultStatus;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "thinking";
      header: string;
      bodyLines: string[];
    }
  | UserMessageView;

export type ToolResultThreadItem = Extract<ThreadItem, { kind: "tool_result" }>;
