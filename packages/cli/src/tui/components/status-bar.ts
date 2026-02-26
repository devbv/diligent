import type { Component } from "../framework/types";

export interface StatusBarInfo {
  model?: string;
  tokensUsed?: number;
  contextWindow?: number;
  sessionId?: string;
  status?: "idle" | "busy" | "retry";
  cwd?: string;
}

function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function shortenPath(cwd: string): string {
  const home = process.env.HOME ?? "";
  const p = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = p.split("/").filter(Boolean);
  if (parts.length > 3) {
    return `…/${parts.slice(-2).join("/")}`;
  }
  return p;
}

/** Bottom status bar showing model, tokens, session info */
export class StatusBar implements Component {
  private info: StatusBarInfo = {};

  update(info: Partial<StatusBarInfo>): void {
    Object.assign(this.info, info);
  }

  render(width: number): string[] {
    const leftParts: string[] = [];

    if (this.info.model) {
      leftParts.push(this.info.model);
    }

    if (this.info.tokensUsed !== undefined) {
      if (this.info.contextWindow) {
        const pct = Math.round((this.info.tokensUsed / this.info.contextWindow) * 100);
        leftParts.push(`${pct}% context left`);
      } else {
        leftParts.push(`${formatTokensCompact(this.info.tokensUsed)} used`);
      }
    }

    if (this.info.cwd) {
      leftParts.push(shortenPath(this.info.cwd));
    }

    const statusHint =
      this.info.status === "busy" ? "ctrl+c to cancel" :
      this.info.status === "retry" ? "retrying…" : "";
    const rightHint = statusHint;

    if (leftParts.length === 0 && !rightHint) return [];

    const leftStr = leftParts.length > 0 ? `  ${leftParts.join(" \u00b7 ")}` : "";

    if (rightHint) {
      const pad = Math.max(1, width - leftStr.length - rightHint.length);
      const full = `${leftStr}${" ".repeat(pad)}${rightHint}`;
      if (full.length <= width) {
        return [`\x1b[2m${full}\x1b[0m`];
      }
    }

    let line = leftStr;
    if (line.length > width) {
      line = line.slice(0, width - 1) + "\u2026";
    }

    return [`\x1b[2m${line}\x1b[0m`];
  }

  invalidate(): void {
    // No cached state
  }
}
