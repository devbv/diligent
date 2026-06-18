// @summary MessageList prop and virtual row types shared across colocated modules

import type { ApprovalRequest, ThreadReadResponse, ThreadStatus, UserInputRequest } from "@diligent/protocol";
import type { RenderItem } from "../../lib/thread-store";

export interface MessageListProps {
  items: RenderItem[];
  threadStatus: ThreadStatus;
  threadCwd?: string;
  hasProvider: boolean;
  oauthPending?: boolean;
  onOpenProviders: () => void;
  onQuickConnectChatGPT?: () => void;
  isCompacting?: boolean;
  approvalPrompt?: {
    request: ApprovalRequest;
    onDecide: (decision: "once" | "always" | "reject") => void;
  } | null;
  questionPrompt?: {
    request: UserInputRequest;
    answers: Record<string, string | string[]>;
    onAnswerChange: (id: string, value: string | string[]) => void;
    onSubmit: () => void;
    onCancel: () => void;
  } | null;
  onLoadChildThread?: (childThreadId: string) => Promise<ThreadReadResponse>;
}

export type CollabItem = Extract<RenderItem, { kind: "collab" }>;
export type MessageContentItem = Exclude<RenderItem, { kind: "collab" }>;
export type ApprovalPrompt = NonNullable<MessageListProps["approvalPrompt"]>;
export type QuestionPrompt = NonNullable<MessageListProps["questionPrompt"]>;
export type VirtuosoScrollBehavior = "auto" | "smooth";

export interface MessageListRow {
  key: string;
  estimatedSize: number;
}

export interface VirtuosoMessageListContext {
  rowCount: number;
  transcriptKey: string;
}

export type VirtualMessageRow =
  | (MessageListRow & { kind: "collab"; items: CollabItem[] })
  | (MessageListRow & { kind: "message"; item: MessageContentItem; suppressThinking?: boolean })
  | (MessageListRow & { kind: "streaming" })
  | (MessageListRow & { kind: "compacting" })
  | (MessageListRow & { kind: "approval"; prompt: ApprovalPrompt })
  | (MessageListRow & { kind: "question"; prompt: QuestionPrompt })
  | (MessageListRow & { kind: "bottom" });
