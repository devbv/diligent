// @summary Extracts metadata from OVERDARE procedural script sources.

import { randomUUID } from "node:crypto";

const generationIdPattern = /^\s*--\s*generationId:\s*(\S+)\s*$/m;
const localModulePattern = /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*\}\s*$/m;

export interface ExtractMetadataOptions {
  /**
   * One-shot mode: when the `-- generationId:` comment is absent, auto-generate
   * a UUID instead of throwing. Persisted models (save/run) still require it as
   * their stable identity, so leave this false there.
   */
  autoGenerationId?: boolean;
}

export function extractProceduralScriptMetadata(
  scriptSource: string,
  fallbackName = "ProceduralScript",
  options: ExtractMetadataOptions = {},
): { generationId: string; scriptName: string } {
  const matched = scriptSource.match(generationIdPattern)?.[1];
  const generationId = matched ?? (options.autoGenerationId ? randomUUID() : undefined);
  if (!generationId) {
    throw new Error("Procedural script is missing required generationId comment.");
  }

  const scriptName = scriptSource.match(localModulePattern)?.[1] ?? fallbackName;
  return { generationId, scriptName };
}
