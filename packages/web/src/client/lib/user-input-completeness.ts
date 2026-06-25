// @summary Shared completeness checks for request_user_input answers before client resolution

import type { UserInputRequest } from "@diligent/protocol";

export type UserInputAnswers = Record<string, string | string[]>;

export function isQuestionAnswered(answer: string | string[] | undefined): answer is string | string[] {
  if (Array.isArray(answer)) {
    return answer.some((value) => value.trim().length > 0);
  }
  return typeof answer === "string" && answer.trim().length > 0;
}

export function isUserInputComplete(request: UserInputRequest, answers: UserInputAnswers): boolean {
  return request.questions.every((question) => isQuestionAnswered(answers[question.id]));
}
