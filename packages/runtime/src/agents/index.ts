export { type AgentDiscoveryOptions, discoverAgents } from "./discovery";
export { parseAgentFrontmatter, validateAgentName } from "./frontmatter";
export { renderAgentsSection } from "./render";
export {
  filterAvailableAgentDefinitions,
  type ResolvedSubagentState,
  resolveSubagentStates,
  type SubagentCatalogEntry,
  type SubagentController,
  type SubagentSource,
  type SubagentStateReason,
} from "./settings";
export type { AgentFrontmatter, AgentLoadError, AgentLoadResult, AgentMetadata } from "./types";
