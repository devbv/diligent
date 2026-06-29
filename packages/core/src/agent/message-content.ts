// @summary Small helpers for editing agent message content

import type { UserMessage } from "../types";

export function updateUserMessageContent(current: UserMessage["content"], content: string): UserMessage["content"] {
  if (typeof current === "string") return content;
  const next = [...current];
  const index = next.findIndex((block) => block.type === "text");
  if (index === -1) return [{ type: "text", text: content }, ...next];
  const block = next[index];
  if (!block || block.type !== "text") return next;
  next[index] = { ...block, text: content };
  return next;
}
