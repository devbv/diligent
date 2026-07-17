import type { ModelClass } from "@diligent/core/model-registry";

export interface AgentFrontmatter {
  name: string;
  description: string;
  tools?: string[];
  model_class?: ModelClass;
}

export interface AgentMetadata {
  name: string;
  description: string;
  filePath: string;
  content: string;
  tools?: string[];
  defaultModelClass?: ModelClass;
  source: "global" | "project" | "config";
}

export interface AgentLoadError {
  filePath: string;
  error: string;
}

export interface AgentLoadResult {
  agents: AgentMetadata[];
  errors: AgentLoadError[];
}
