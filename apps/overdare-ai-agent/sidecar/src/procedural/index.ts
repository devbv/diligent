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
export { deriveProceduralOps } from "./ops";
export {
  PROCEDURAL_RECIPE_ID_PATTERN,
  proceduralRecipesDir,
  readRecipeScript,
  recipeDir,
  recipeScriptPath,
  recipeScriptRelativePath,
} from "./recipe";
export type { ProceduralLuauRuntimeOptions } from "./runtime";
export { generateProceduralDummyJson, resolveLuauExecutable, runProceduralScript } from "./runtime";
export { extractProceduralScriptName } from "./script-metadata";
export type * from "./types";
