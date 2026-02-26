import type { Component } from "../framework/types";

export interface StatusBarInfo {
  model?: string;
  tokensUsed?: number;
  contextWindow?: number;
  sessionId?: string;
  status?: "idle" | "busy" | "retry";
}

/** Bottom status bar showing model, tokens, session info */
export class StatusBar implements Component {
  private info: StatusBarInfo = {};

  update(info: Partial<StatusBarInfo>): void {
    Object.assign(this.info, info);
  }

  render(width: number): string[] {
    const parts: string[] = [];

    if (this.info.model) {
      parts.push(this.info.model);
    }

    if (this.info.tokensUsed !== undefined) {
      if (this.info.contextWindow) {
        const pct = Math.round((this.info.tokensUsed / this.info.contextWindow) * 100);
        parts.push(
          `${Math.round(this.info.tokensUsed / 1000)}k/${Math.round(this.info.contextWindow / 1000)}k (${pct}%)`,
        );
      } else {
        parts.push(`${Math.round(this.info.tokensUsed / 1000)}k tokens`);
      }
    }

    if (this.info.status && this.info.status !== "idle") {
      parts.push(this.info.status);
    }

    if (parts.length === 0) return [];

    let line = parts.join(" \u00b7 ");

    // Truncate to fit width
    if (line.length > width) {
      line = line.slice(0, width - 1) + "\u2026";
    }

    return [`\x1b[2m${line}\x1b[0m`];
  }

  invalidate(): void {
    // No cached state
  }
}
