// @summary Canonical runtime eval task manifest

import type { AnyRuntimeEvalTask } from "../../runtime-task";
import { planReadonlyTask } from "./plan-readonly";
import { projectFixTask } from "./project-fix";
import { sessionResumeTask } from "./session-resume";
import { skillGuidedChangeTask } from "./skill-guided-change";

export const RUNTIME_CANONICAL_TASKS: readonly AnyRuntimeEvalTask[] = [
  projectFixTask,
  planReadonlyTask,
  skillGuidedChangeTask,
  sessionResumeTask,
];
export const RUNTIME_EVAL_TASKS = RUNTIME_CANONICAL_TASKS;
