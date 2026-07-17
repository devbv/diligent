// @summary Registries for canonical and candidate core eval tasks

import type { AnyEvalTask } from "../../task";
import { directResponseTask } from "./direct-response";
import { parallelToolsTask } from "./parallel-tools";
import { recoverToolErrorTask } from "./recover-tool-error";
import { singleToolTask } from "./single-tool";
import { structuredToolArgsTask } from "./structured-tool-args";
import { toolChainTask } from "./tool-chain";

export type { DirectResponseWorld } from "./direct-response";
export { directResponseTask } from "./direct-response";
export type { ParallelToolFragment, ParallelToolsWorld } from "./parallel-tools";
export { parallelToolsTask } from "./parallel-tools";
export type { RecoverToolErrorWorld } from "./recover-tool-error";
export { recoverToolErrorTask } from "./recover-tool-error";
export type { SingleToolWorld } from "./single-tool";
export { singleToolTask } from "./single-tool";
export type { StructuredToolArgsWorld } from "./structured-tool-args";
export { structuredToolArgsTask } from "./structured-tool-args";
export type { ToolChainWorld } from "./tool-chain";
export { toolChainTask } from "./tool-chain";

export const CORE_CANONICAL_TASKS: readonly AnyEvalTask[] = [
  directResponseTask,
  singleToolTask,
  toolChainTask,
  recoverToolErrorTask,
];

export const CORE_CANDIDATE_TASKS: readonly AnyEvalTask[] = [structuredToolArgsTask, parallelToolsTask];

export const CORE_EVAL_TASKS: readonly AnyEvalTask[] = [...CORE_CANONICAL_TASKS, ...CORE_CANDIDATE_TASKS];
