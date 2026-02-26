import type { Command } from "../types";

export const newCommand: Command = {
  name: "new",
  description: "Start a new session",
  handler: async (_args, ctx) => {
    if (!ctx.sessionManager) {
      ctx.displayError("No .diligent/ directory — sessions not available.");
      return;
    }
    await ctx.sessionManager.create();
    ctx.displayLines(["  \x1b[2mNew session started.\x1b[0m"]);
  },
};

export const resumeCommand: Command = {
  name: "resume",
  description: "Resume session or show picker",
  supportsArgs: true,
  handler: async (args, ctx) => {
    if (!ctx.sessionManager) {
      ctx.displayError("No .diligent/ directory — sessions not available.");
      return;
    }

    if (args) {
      const resumed = await ctx.sessionManager.resume({ sessionId: args });
      if (resumed) {
        ctx.displayLines([`  \x1b[2mResumed session: ${args}\x1b[0m`]);
      } else {
        ctx.displayError(`Session not found: ${args}`);
      }
      return;
    }

    // Show session picker
    const sessions = await ctx.sessionManager.list();
    if (sessions.length === 0) {
      ctx.displayLines(["  \x1b[2mNo sessions found.\x1b[0m"]);
      return;
    }

    const { ListPicker } = await import("../../components/list-picker");
    const items = sessions.map(s => ({
      label: s.id,
      description: s.modified.toLocaleString(),
      value: s.id,
    }));

    return new Promise<void>(resolve => {
      const picker = new ListPicker(
        { title: "Sessions", items },
        async (value) => {
          handle.hide();
          ctx.requestRender();
          if (value) {
            const resumed = await ctx.sessionManager?.resume({ sessionId: value });
            if (resumed) {
              ctx.displayLines([`  \x1b[2mResumed session: ${value}\x1b[0m`]);
            }
          }
          resolve();
        },
      );
      const handle = ctx.showOverlay(picker, { anchor: "center" });
      ctx.requestRender();
    });
  },
};

export const statusCommand: Command = {
  name: "status",
  description: "Show session info and model",
  availableDuringTask: true,
  handler: async (_args, ctx) => {
    const lines: string[] = [""];
    lines.push(`  \x1b[1mModel:\x1b[0m    ${ctx.config.model.id} (${ctx.config.model.provider})`);

    if (ctx.sessionManager) {
      lines.push(`  \x1b[1mEntries:\x1b[0m  ${ctx.sessionManager.entryCount}`);
      const path = ctx.sessionManager.sessionPath;
      if (path) {
        lines.push(`  \x1b[1mSession:\x1b[0m  ${path}`);
      }
    }

    if (ctx.config.sources.length > 0) {
      lines.push(`  \x1b[1mConfig:\x1b[0m   ${ctx.config.sources.join(", ")}`);
    }

    if (ctx.skills.length > 0) {
      lines.push(`  \x1b[1mSkills:\x1b[0m   ${ctx.skills.length} loaded`);
    }

    lines.push("");
    ctx.displayLines(lines);
  },
};
