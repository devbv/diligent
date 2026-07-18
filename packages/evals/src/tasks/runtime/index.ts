// @summary Registry for all runtime eval tasks

import type { AnyRuntimeEvalTask } from "../../runtime-task";
import { clarifyThenExecuteTask } from "./clarify-then-execute";
import { collaborationDelegationTask } from "./collaboration-delegation";
import { fileRoundtripTask } from "./file-roundtrip";
import { knowledgeRecallTask } from "./knowledge-recall";
import { knowledgeUpdateTask } from "./knowledge-update";
import { manualCompactionResumeTask } from "./manual-compaction-resume";
import { planReadonlyTask } from "./plan-readonly";
import { planToExecuteTask } from "./plan-to-execute";
import { projectFixTask } from "./project-fix";
import { readImagePairTask } from "./read-image-pair";
import { sessionResumeTask } from "./session-resume";
import { skillGuidedChangeTask } from "./skill-guided-change";

export type { ClarifyThenExecuteWorld } from "./clarify-then-execute";
export { clarifyThenExecuteTask } from "./clarify-then-execute";
export type { CollaborationDelegationWorld } from "./collaboration-delegation";
export { collaborationDelegationTask } from "./collaboration-delegation";
export type { FileRoundtripWorld } from "./file-roundtrip";
export { fileRoundtripTask } from "./file-roundtrip";
export type { KnowledgeRecallWorld } from "./knowledge-recall";
export { knowledgeRecallTask } from "./knowledge-recall";
export type { KnowledgeUpdateWorld } from "./knowledge-update";
export { knowledgeUpdateTask } from "./knowledge-update";
export type { ManualCompactionResumeWorld } from "./manual-compaction-resume";
export { manualCompactionResumeTask } from "./manual-compaction-resume";
export type { PlanToExecuteWorld } from "./plan-to-execute";
export { planToExecuteTask } from "./plan-to-execute";
export type { ReadImagePairWorld } from "./read-image-pair";
export { readImagePairTask } from "./read-image-pair";

export const RUNTIME_EVAL_TASKS: readonly AnyRuntimeEvalTask[] = [
  projectFixTask,
  planReadonlyTask,
  skillGuidedChangeTask,
  sessionResumeTask,
  planToExecuteTask,
  knowledgeRecallTask,
  knowledgeUpdateTask,
  manualCompactionResumeTask,
  clarifyThenExecuteTask,
  readImagePairTask,
  collaborationDelegationTask,
  fileRoundtripTask,
];
