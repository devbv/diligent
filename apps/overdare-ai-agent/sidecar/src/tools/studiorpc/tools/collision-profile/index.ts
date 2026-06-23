// @summary Factory for collision channel and profile CRUD tools.

import type { Tool } from "../../types";
import type { WriteLock } from "../../write-lock";
import { createCollisionChannelTools } from "./channel-tools";
import { createCollisionProfileCrudTools } from "./profile-tools";

export function createCollisionProfileTools(cwd: string, writeLock: WriteLock): Tool[] {
  return [...createCollisionChannelTools(cwd, writeLock), ...createCollisionProfileCrudTools(cwd, writeLock)];
}
