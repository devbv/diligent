// @summary Mirrors Studio's Workspace Mobility cascade onto the local tree.

import { normalizeWorkspaceMobility } from "../instance-document-operations";
import type { OvdrjmNode } from "../ovdrjm-utils";

/**
 * Studio cascades a top-level object's Mobility down its whole assembly by itself,
 * and refuses a Mobility set on anything below Workspace — sending the cascade
 * would come back as "Mobility can only be changed on instances directly under
 * Workspace". Only the local tree is brought in line, so the UI diagnostics and the
 * tool output match what the file backend produces.
 */
export function applyMobilityCascade(root: OvdrjmNode): void {
  normalizeWorkspaceMobility(root);
}
