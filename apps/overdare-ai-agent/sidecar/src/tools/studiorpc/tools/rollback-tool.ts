// @summary Rolls the Studio map back to the snapshot taken before the agent's last request.
import { z } from "zod";
import type { call } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import { findLatestSnapshot, restoreSnapshot } from "./snapshot";

const params = z.object({});

const description =
  "Roll the Studio map back to the state right before the agent's most recent request, using the saved " +
  "snapshot. Deterministic full restore: the entire map is reverted to the snapshot, discarding any changes " +
  "made since (including the user's own edits).";

/**
 * Restore flow (PRD 4.2): save (flush editor) -> overwrite ovdrjm with the
 * pre-request snapshot -> apply (sync editor) -> save (persist).
 */
export function createRollbackTool(cwd: string, callRpc: typeof call): Tool {
  return {
    name: "studiorpc_rollback",
    description,
    parameters: params,
    async execute(_rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const approval = await ctx.approve({
        permission: "execute",
        toolName: "studiorpc_rollback",
        description: "Roll back the Studio map to the pre-request snapshot",
        details: {},
      });
      if (approval === "reject") {
        return { output: "[Rejected by user]", metadata: { error: true, method: "rollback" } };
      }

      // Flush the current editor state so the level files are consistent.
      await callRpc("level.save.file", {});

      let snapshot: ReturnType<typeof findLatestSnapshot>;
      try {
        snapshot = findLatestSnapshot(cwd);
      } catch (error) {
        return { output: (error as Error).message, metadata: { error: true, method: "rollback" } };
      }

      restoreSnapshot(cwd, snapshot.path);
      await callRpc("level.apply", {});
      await callRpc("level.save.file", {});

      return {
        output: `Rolled back to snapshot ${snapshot.id} (pre-request state).`,
        metadata: { method: "rollback", restored: snapshot.id },
      };
    },
  };
}
