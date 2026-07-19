// @summary Registry for all runtime eval tasks

import type { AnyRuntimeEvalTask } from "../../runtime-task";
import { autoCompactionResumeTask } from "./auto-compaction-resume";
import { bundledToolRoutingTask } from "./bundled-tool-routing";
import { clarifyThenExecuteTask } from "./clarify-then-execute";
import { collaborationParallelSynthesisTask } from "./collaboration-parallel-synthesis";
import { collaborationResumeReferenceTask } from "./collaboration-resume-reference";
import { customAgentRoutingTask } from "./custom-agent-routing";
import { executeAutonomousTask } from "./execute-autonomous";
import { fileRoundtripTask } from "./file-roundtrip";
import { hookContextFollowTask } from "./hook-context-follow";
import { imageResumeRecallTask } from "./image-resume-recall";
import { instructionHierarchyTask } from "./instruction-hierarchy";
import { knowledgeForgetTask } from "./knowledge-forget";
import { knowledgeIntentSplitTask } from "./knowledge-intent-split";
import { knowledgeRecallTask } from "./knowledge-recall";
import { largeOutputRecoveryTask } from "./large-output-recovery";
import { loopContextAdaptationTask } from "./loop-context-adaptation";
import { manualCompactionResumeTask } from "./manual-compaction-resume";
import { mcpLazyToolTask } from "./mcp-lazy-tool";
import { mcpPromptGroundingTask } from "./mcp-prompt-grounding";
import { mcpResourceGroundingTask } from "./mcp-resource-grounding";
import { planConvergeTask } from "./plan-converge";
import { planProgressTask } from "./plan-progress";
import { planReadonlyTask } from "./plan-readonly";
import { planToExecuteTask } from "./plan-to-execute";
import { projectFixTask } from "./project-fix";
import { readImagePairTask } from "./read-image-pair";
import { sessionResumeTask } from "./session-resume";
import { skillAbstainTask } from "./skill-abstain";
import { skillAutoSelectTask } from "./skill-auto-select";
import { steerDuringFixTask } from "./steer-during-fix";

export type { AutoCompactionResumeWorld } from "./auto-compaction-resume";
export { autoCompactionResumeTask } from "./auto-compaction-resume";
export type { BundledToolRoutingWorld } from "./bundled-tool-routing";
export { bundledToolRoutingTask } from "./bundled-tool-routing";
export type { ClarifyThenExecuteWorld } from "./clarify-then-execute";
export { clarifyThenExecuteTask } from "./clarify-then-execute";
export type { CollaborationParallelSynthesisWorld } from "./collaboration-parallel-synthesis";
export { collaborationParallelSynthesisTask } from "./collaboration-parallel-synthesis";
export type { CollaborationResumeReferenceWorld } from "./collaboration-resume-reference";
export { collaborationResumeReferenceTask } from "./collaboration-resume-reference";
export type { CustomAgentRoutingWorld } from "./custom-agent-routing";
export { customAgentRoutingTask } from "./custom-agent-routing";
export type { ExecuteAutonomousWorld } from "./execute-autonomous";
export { executeAutonomousTask } from "./execute-autonomous";
export type { FileRoundtripWorld } from "./file-roundtrip";
export { fileRoundtripTask } from "./file-roundtrip";
export type { HookContextFollowWorld } from "./hook-context-follow";
export { hookContextFollowTask } from "./hook-context-follow";
export type { ImageResumeRecallWorld } from "./image-resume-recall";
export { imageResumeRecallTask } from "./image-resume-recall";
export type { InstructionHierarchyWorld } from "./instruction-hierarchy";
export { instructionHierarchyTask } from "./instruction-hierarchy";
export type { KnowledgeForgetWorld } from "./knowledge-forget";
export { knowledgeForgetTask } from "./knowledge-forget";
export type { KnowledgeIntentSplitWorld } from "./knowledge-intent-split";
export { knowledgeIntentSplitTask } from "./knowledge-intent-split";
export type { KnowledgeRecallWorld } from "./knowledge-recall";
export { knowledgeRecallTask } from "./knowledge-recall";
export type { LargeOutputRecoveryWorld } from "./large-output-recovery";
export { largeOutputRecoveryTask } from "./large-output-recovery";
export type { LoopContextAdaptationWorld } from "./loop-context-adaptation";
export { loopContextAdaptationTask } from "./loop-context-adaptation";
export type { ManualCompactionResumeWorld } from "./manual-compaction-resume";
export { manualCompactionResumeTask } from "./manual-compaction-resume";
export type { McpLazyToolWorld } from "./mcp-lazy-tool";
export { mcpLazyToolTask } from "./mcp-lazy-tool";
export type { McpPromptGroundingWorld } from "./mcp-prompt-grounding";
export { mcpPromptGroundingTask } from "./mcp-prompt-grounding";
export type { McpResourceGroundingWorld } from "./mcp-resource-grounding";
export { mcpResourceGroundingTask } from "./mcp-resource-grounding";
export type { PlanConvergeWorld } from "./plan-converge";
export { planConvergeTask } from "./plan-converge";
export type { PlanProgressWorld } from "./plan-progress";
export { planProgressTask } from "./plan-progress";
export type { PlanToExecuteWorld } from "./plan-to-execute";
export { planToExecuteTask } from "./plan-to-execute";
export type { ReadImagePairWorld } from "./read-image-pair";
export { readImagePairTask } from "./read-image-pair";
export type { SkillAbstainWorld } from "./skill-abstain";
export { skillAbstainTask } from "./skill-abstain";
export type { SkillAutoSelectWorld } from "./skill-auto-select";
export { skillAutoSelectTask } from "./skill-auto-select";
export type { SteerDuringFixWorld } from "./steer-during-fix";
export { steerDuringFixTask } from "./steer-during-fix";

export const RUNTIME_EVAL_TASKS: readonly AnyRuntimeEvalTask[] = [
  projectFixTask,
  planReadonlyTask,
  sessionResumeTask,
  planToExecuteTask,
  knowledgeRecallTask,
  manualCompactionResumeTask,
  clarifyThenExecuteTask,
  readImagePairTask,
  fileRoundtripTask,
  instructionHierarchyTask,
  planConvergeTask,
  executeAutonomousTask,
  planProgressTask,
  hookContextFollowTask,
  skillAutoSelectTask,
  skillAbstainTask,
  knowledgeIntentSplitTask,
  knowledgeForgetTask,
  steerDuringFixTask,
  autoCompactionResumeTask,
  imageResumeRecallTask,
  loopContextAdaptationTask,
  largeOutputRecoveryTask,
  bundledToolRoutingTask,
  mcpLazyToolTask,
  mcpResourceGroundingTask,
  mcpPromptGroundingTask,
  customAgentRoutingTask,
  collaborationParallelSynthesisTask,
  collaborationResumeReferenceTask,
];
