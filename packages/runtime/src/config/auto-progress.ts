// @summary Account-scoped auto progress mode helpers

import type { DiligentConfig } from "./schema";

export function resolveAutoProgressMode(
  config: Pick<DiligentConfig, "accounts" | "autoProgressMode" | "userId">,
): boolean {
  const userId = config.userId?.trim();
  return (userId ? config.accounts?.[userId]?.autoProgressMode : undefined) ?? config.autoProgressMode ?? false;
}
