// @summary Registry for all core eval tasks

import type { AnyEvalTask } from "../../task";
import { directResponseTask } from "./direct-response";
import { imageToolResultTask } from "./image-tool-result";
import { parallelToolsTask } from "./parallel-tools";
import { recoverToolErrorTask } from "./recover-tool-error";
import { singleToolTask } from "./single-tool";
import { structuredToolArgsTask } from "./structured-tool-args";
import { toolChainTask } from "./tool-chain";

export type { DirectResponseWorld } from "./direct-response";
export { directResponseTask } from "./direct-response";
export type { ImageToolResultWorld } from "./image-tool-result";
export { imageToolResultTask } from "./image-tool-result";
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

export const CORE_EVAL_TASKS: readonly AnyEvalTask[] = [
  directResponseTask,
  singleToolTask,
  toolChainTask,
  recoverToolErrorTask,
  structuredToolArgsTask,
  parallelToolsTask,
  imageToolResultTask,
];
