// @summary Public exports for the OVERDARE Luau procedural runtime.

export {
  assertGeneratedNodeCountWithinLimit,
  assertInputWithinArgvLimit,
  assertInputWithinLimit,
  assertNodeCountWithinLimit,
  countGeneratedTreeNodes,
  countTreeNodes,
  DEFAULT_PROCEDURAL_LIMITS,
  type ProceduralLimits,
  resolveLimits,
} from "./limits";
export { DIFF_PROPERTY_WHITELIST, deriveProceduralOps } from "./ops";
export type { ProceduralLuauRuntimeOptions } from "./runtime";
export { generateProceduralDummyJson, resolveLuauExecutable, runProceduralScript } from "./runtime";
export { extractProceduralScriptMetadata } from "./script-metadata";
export type * from "./types";
