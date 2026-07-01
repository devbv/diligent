// @summary Session management commands - create new session and list sessions
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import { t } from "../../theme";
import type { Command } from "../types";

export const newCommand: Command = {
  name: "new",
  description: "Start a new session",
  handler: async (_args, ctx) => {
    const threadId = await ctx.startNewThread();
    ctx.displayLines([`  ${t.dim}New thread started: ${threadId}${t.reset}`]);
  },
};

export const resumeCommand: Command = {
  name: "resume",
  description: "Resume thread or show picker",
  supportsArgs: true,
  handler: async (args, ctx) => {
    if (args) {
      const resumedId = await ctx.resumeThread(args);
      if (resumedId) {
        ctx.displayLines([`  ${t.dim}Resumed thread: ${resumedId}${t.reset}`]);
      } else {
        ctx.displayError(`Thread not found: ${args}`);
      }
      return;
    }

    // Show thread picker
    const threads = await ctx.listThreads();
    if (threads.length === 0) {
      ctx.displayLines([`  ${t.dim}No threads found.${t.reset}`]);
      return;
    }

    const items = threads.map((thread) => ({
      label: thread.id,
      description: thread.modified,
      value: thread.id,
    }));
    const value = await ctx.app.pick({ title: "Threads", items });
    if (value) {
      const resumedId = await ctx.resumeThread(value);
      if (resumedId) {
        ctx.displayLines([`  ${t.dim}Resumed thread: ${resumedId}${t.reset}`]);
      }
    }
  },
};

export const deleteCommand: Command = {
  name: "delete",
  description: "Delete a session",
  supportsArgs: true,
  handler: async (args, ctx) => {
    const threadId = args?.trim();

    const doDelete = async (id: string): Promise<void> => {
      const confirmed = await ctx.app.confirm({
        title: "Delete session",
        message: `Delete ${id}? This cannot be undone.`,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
      });
      if (!confirmed) return;

      const deleted = await ctx.deleteThread(id);
      if (deleted) {
        ctx.displayLines([`  ${t.dim}Session deleted: ${id}${t.reset}`]);
      } else {
        ctx.displayError(`Session not found: ${id}`);
      }
    };

    if (threadId) {
      await doDelete(threadId);
      return;
    }

    // Show picker
    const threads = await ctx.listThreads();
    if (threads.length === 0) {
      ctx.displayLines([`  ${t.dim}No sessions found.${t.reset}`]);
      return;
    }

    const items = threads.map((thread) => ({
      label: thread.firstUserMessage ?? thread.id,
      description: thread.modified,
      value: thread.id,
    }));
    const value = await ctx.app.pick({ title: "Delete Session", items });
    if (value) {
      await doDelete(value);
    }
  },
};

export const statusCommand: Command = {
  name: "status",
  description: "Show thread info and model",
  availableDuringTask: true,
  handler: async (_args, ctx) => {
    const lines: string[] = [""];
    lines.push(`  ${t.bold}Model:${t.reset}    ${ctx.config.model.id} (${ctx.config.model.provider})`);

    if (ctx.threadId) {
      lines.push(`  ${t.bold}Thread:${t.reset}   ${ctx.threadId}`);
      const thread = await ctx.readThread();
      if (thread) {
        lines.push(`  ${t.bold}Entries:${t.reset}  ${thread.entryCount}`);
      }
    } else {
      lines.push(`  ${t.bold}Thread:${t.reset}   (none)`);
    }

    if (ctx.config.sources.length > 0) {
      lines.push(`  ${t.bold}Config:${t.reset}   ${ctx.config.sources.join(", ")}`);
    }

    if (ctx.skills.length > 0) {
      lines.push(`  ${t.bold}Skills:${t.reset}   ${ctx.skills.length} loaded`);
    }

    // Best-effort MCP summary; swallow errors so /status never fails on MCP issues.
    try {
      const rpc = ctx.app.getRpcClient?.();
      if (rpc) {
        const { servers } = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LIST, {
          threadId: ctx.threadId ?? undefined,
        });
        if (servers.length > 0) {
          const connected = servers.filter((s) => s.status === "connected").length;
          const needsAuth = servers.filter((s) => s.status === "needs_auth").length;
          const suffix = needsAuth > 0 ? ` ${t.warn}(${needsAuth} need login)${t.reset}` : "";
          lines.push(`  ${t.bold}MCP:${t.reset}      ${connected}/${servers.length} connected${suffix}`);
        }
      }
    } catch {
      // ignore — MCP status is non-essential to /status
    }

    lines.push("");
    ctx.displayLines(lines);
  },
};
