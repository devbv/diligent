// @summary Lists rollback snapshots with labels so a specific restore point can be chosen.

import { z } from "zod";
import type { Tool, ToolResult } from "../types";
import { listSnapshots, truncateLabel } from "./snapshot";

const params = z.object({});

const description =
  "List rollback snapshots for this Studio project, newest first. Each entry has an id (pass it to " +
  "studiorpc_rollback's snapshotId), a label (the user request captured with it), createdAt, and kind. " +
  "'turn' snapshots hold the map state right BEFORE the labeled request ran — restoring one undoes that " +
  "request and everything after it. To return to the state right AFTER a request completed, restore the " +
  "snapshot of the NEXT editing request instead. 'pre-rollback' is the state saved just before a rollback " +
  "ran — restore it to undo that rollback.";

export function createSnapshotListTool(cwd: string): Tool {
  return {
    name: "studiorpc_snapshot_list",
    description,
    parameters: params,
    async execute(): Promise<ToolResult> {
      const entries = listSnapshots(cwd).map(({ path: _path, ...entry }) => ({
        ...entry,
        ...(entry.label !== undefined ? { label: truncateLabel(entry.label) } : {}),
      }));
      return {
        output: entries.length > 0 ? JSON.stringify(entries, null, 2) : "No snapshots found.",
        metadata: { method: "snapshot.list", count: entries.length },
      };
    },
  };
}
