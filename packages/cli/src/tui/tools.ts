import type { DiligentPaths, Tool } from "@diligent/core";
import {
  bashTool,
  createAddKnowledgeTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@diligent/core";

export function buildTools(cwd: string, paths?: DiligentPaths): Tool[] {
  const tools: Tool[] = [
    bashTool,
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createLsTool(),
    createGlobTool(cwd),
    createGrepTool(cwd),
  ];

  if (paths) {
    tools.push(createAddKnowledgeTool(paths.knowledge));
  }

  return tools;
}
