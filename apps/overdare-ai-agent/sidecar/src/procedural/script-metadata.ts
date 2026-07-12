// @summary Extracts a readable module name from OVERDARE procedural script sources.

const localModulePattern = /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*\}\s*$/m;

export function extractProceduralScriptName(scriptSource: string, fallbackName = "ProceduralScript"): string {
  return scriptSource.match(localModulePattern)?.[1] ?? fallbackName;
}
