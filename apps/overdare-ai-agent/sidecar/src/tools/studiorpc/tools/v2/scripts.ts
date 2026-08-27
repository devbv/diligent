// @summary Shared script-instance constants for the Studio v2 script tools.

export const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

export function instanceTypeOf(node: Record<string, unknown>): string | undefined {
  return typeof node.InstanceType === "string" ? node.InstanceType : undefined;
}
