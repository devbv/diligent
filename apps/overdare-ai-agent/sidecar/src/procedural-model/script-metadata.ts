// @summary Extracts metadata from OVERDARE procedural script sources.

const generationIdPattern = /^\s*--\s*generationId:\s*(\S+)\s*$/m;
const localModulePattern = /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*\}\s*$/m;

export function extractProceduralScriptMetadata(
  scriptSource: string,
  fallbackName = "ProceduralScript",
): { generationId: string; scriptName: string } {
  const generationId = scriptSource.match(generationIdPattern)?.[1];
  if (!generationId) {
    throw new Error("Procedural script is missing required generationId comment.");
  }

  const scriptName = scriptSource.match(localModulePattern)?.[1] ?? fallbackName;
  return { generationId, scriptName };
}
