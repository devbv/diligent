import type { ModeKind } from "@diligent/core";
import type { Component } from "../framework/types";
import { t } from "../theme";

export interface StatusBarInfo {
  model?: string;
  tokensUsed?: number;
  contextWindow?: number;
  sessionId?: string;
  status?: "idle" | "busy" | "retry";
  cwd?: string;
  mode?: ModeKind;
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

const MODE_COLORS: Record<string, string> = {
  plan: t.modePlan,
  execute: t.modeExecute,
};

function formatModeHint(mode: ModeKind): string {
  const color = MODE_COLORS[mode] ?? "";
  return `${t.boldOff}${color}${mode} mode${t.reset}${t.dim}  (shift+tab to cycle)`;
}

/** Visible length excluding ANSI escape codes */
function visibleLength(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
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
    const modeHint =
      !statusHint && this.info.mode && this.info.mode !== "default"
        ? formatModeHint(this.info.mode)
        : "";
    const rightHint = statusHint || modeHint;

    if (leftParts.length === 0 && !rightHint) return [];

    const leftStr = leftParts.length > 0 ? `  ${leftParts.join(" \u00b7 ")}` : "";

    if (rightHint) {
      const rightVisible = visibleLength(rightHint);
      const pad = Math.max(1, width - leftStr.length - rightVisible);
      const full = `${t.dim}${leftStr}${" ".repeat(pad)}${rightHint}${t.reset}`;
      if (leftStr.length + pad + rightVisible <= width) {
        return [full];
      }
    }

    let line = leftStr;
    if (line.length > width) {
      line = line.slice(0, width - 1) + "\u2026";
    }

    return [`${t.dim}${line}${t.reset}`];
  }

  invalidate(): void {
    // No cached state
  }
}
