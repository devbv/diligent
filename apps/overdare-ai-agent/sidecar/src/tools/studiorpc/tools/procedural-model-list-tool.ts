// @summary List persisted procedural models so model_run can discover their ids.

import { z } from "zod";
import { listManifests } from "../../../procedural/manifest";
import type { Tool, ToolResult } from "../types";

const TOOL_NAME = "studiorpc_procedural_model_list";

const params = z.object({}).strip();

function executeProceduralModelList(cwd: string): ToolResult {
  const models = listManifests(cwd).map((manifest) => ({
    id: manifest.generationId,
    scriptName: manifest.scriptName,
    parameters: manifest.parameters,
    applied: (manifest.rootGuids ?? []).length > 0,
    rootGuids: manifest.rootGuids ?? [],
    parentGuid: manifest.parentGuid,
    updatedAt: manifest.updatedAt,
  }));
  return {
    output: models.length > 0 ? JSON.stringify(models, null, 2) : "No saved procedural models.",
    metadata: { method: "procedural.model.list", count: models.length, models },
  };
}

export function createProceduralModelListTool(cwd: string): Tool {
  return {
    name: TOOL_NAME,
    description:
      "List saved OVERDARE procedural models (id, script name, stored parameters, whether a generation is " +
      "currently applied, and last-updated time). Use the returned `id` with studiorpc_procedural_model_run.",
    parameters: params,
    parseArgs: (raw) => params.parse(raw as Record<string, unknown>),
    async execute() {
      return executeProceduralModelList(cwd);
    },
  };
}
