// @summary Factory for collision channel and profile CRUD tools.

import type { Tool } from "../../types";
import type { WriteLock } from "../../write-lock";
import { createCollisionChannelTools } from "./channel-tools";
import { createCollisionProfileCrudTools } from "./profile-tools";

export type ApplyLevelChanges = () => Promise<unknown>;

export function createCollisionProfileTools(
  cwd: string,
  writeLock: WriteLock,
  applyLevelChanges: ApplyLevelChanges,
): Tool[] {
  return [
    ...createCollisionChannelTools(cwd, writeLock, applyLevelChanges),
    ...createCollisionProfileCrudTools(cwd, writeLock, applyLevelChanges),
  ];
}
