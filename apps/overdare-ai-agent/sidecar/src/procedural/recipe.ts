// @summary Canonical project-local paths for reusable procedural recipes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PROCEDURAL_RECIPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function proceduralRecipesDir(cwd: string): string {
  return join(cwd, ".overdare", "procedural");
}

export function recipeDir(cwd: string, id: string): string {
  return join(proceduralRecipesDir(cwd), id);
}

export function recipeScriptRelativePath(id: string): string {
  return join(".overdare", "procedural", id, "main.lua");
}

export function recipeScriptPath(cwd: string, id: string): string {
  return join(recipeDir(cwd, id), "main.lua");
}

export function readRecipeScript(cwd: string, id: string): { scriptSource: string; scriptRef: string } {
  const scriptPath = recipeScriptPath(cwd, id);
  if (!existsSync(scriptPath)) {
    throw new Error(
      `Procedural recipe "${id}" does not exist. Create or edit ${recipeScriptRelativePath(id)} and run it again.`,
    );
  }
  return { scriptSource: readFileSync(scriptPath, "utf8"), scriptRef: recipeScriptRelativePath(id) };
}
