// @summary Registry of the four canonical core eval tasks

import type { AnyEvalTask } from "../../task";
import { directResponseTask } from "./direct-response";
import { recoverToolErrorTask } from "./recover-tool-error";
import { singleToolTask } from "./single-tool";
import { toolChainTask } from "./tool-chain";

export type { DirectResponseWorld } from "./direct-response";
export { directResponseTask } from "./direct-response";
export type { RecoverToolErrorWorld } from "./recover-tool-error";
export { recoverToolErrorTask } from "./recover-tool-error";
export type { SingleToolWorld } from "./single-tool";
export { singleToolTask } from "./single-tool";
export type { ToolChainWorld } from "./tool-chain";
export { toolChainTask } from "./tool-chain";

export const CORE_EVAL_TASKS: readonly AnyEvalTask[] = [
  directResponseTask,
  singleToolTask,
  toolChainTask,
  recoverToolErrorTask,
];
