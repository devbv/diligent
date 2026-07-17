// @summary Renders colocated MessageList virtual row descriptors into concrete row UI

import type { ThreadReadResponse } from "@diligent/protocol";
import { ApprovalCard } from "../ApprovalCard";
import { AssistantMessage } from "../AssistantMessage";
import { CollabGroup } from "../CollabGroup";
import { CompactingIndicator } from "../CompactingIndicator";
import { ContextMessage } from "../ContextMessage";
import { HumanEditsNotice } from "../HumanEditsNotice";
import { AgentLogo } from "../icons";
import { QuestionCard } from "../QuestionCard";
import { StreamingIndicator } from "../StreamingIndicator";
import { ToolActivityGroup } from "../ToolActivityGroup";
import { ToolBlock } from "../ToolBlock";
import { UserMessage } from "../UserMessage";
import type { VirtualMessageRow } from "./types";

export function MessageListRowContent({
  row,
  threadCwd,
  onLoadChildThread,
}: {
  row: VirtualMessageRow;
  threadCwd?: string;
  onLoadChildThread?: (childThreadId: string) => Promise<ThreadReadResponse>;
}) {
  switch (row.kind) {
    case "collab":
      return <CollabGroup items={row.items} loadChildThread={onLoadChildThread} />;
    case "toolGroup":
      return <ToolActivityGroup items={row.items} />;
    case "message":
      switch (row.item.kind) {
        case "context":
          return row.item.variant === "human-edits" ? (
            <HumanEditsNotice summary={row.item.summary} />
          ) : (
            <ContextMessage summary={row.item.summary} label={row.item.title} />
          );
        case "tool":
          return <ToolBlock item={row.item} threadCwd={threadCwd} />;
        case "user":
          return <UserMessage text={row.item.text} images={row.item.images} contextItems={row.item.contextItems} />;
        case "assistant":
          return <AssistantMessage item={row.item} suppressThinking={row.suppressThinking ?? false} />;
      }
      break;
    case "streaming":
      return (
        <div className="py-1">
          <div className="flex items-center pt-1">
            <StreamingIndicator />
          </div>
        </div>
      );
    case "responseComplete":
      return (
        <div className="py-1">
          <div className="flex items-center pt-1" role="img" aria-label="Response complete">
            <AgentLogo className="h-8 w-8 text-text" aria-hidden="true" />
          </div>
        </div>
      );
    case "compacting":
      return (
        <div className="py-1">
          <div className="flex items-center pt-1">
            <CompactingIndicator />
          </div>
        </div>
      );
    case "approval":
      return (
        <div className="py-1">
          <ApprovalCard request={row.prompt.request} onDecide={row.prompt.onDecide} />
        </div>
      );
    case "question":
      return (
        <div className="py-1">
          <QuestionCard
            request={row.prompt.request}
            answers={row.prompt.answers}
            onAnswerChange={row.prompt.onAnswerChange}
            onSubmit={row.prompt.onSubmit}
            onCancel={row.prompt.onCancel}
          />
        </div>
      );
    case "bottom":
      return <div className="h-px" />;
  }
}
