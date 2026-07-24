// @summary Inline chat card for tool permission approval (once / always / reject)

import type { ApprovalRequest } from "@diligent/protocol";
import { Button } from "./Button";
import { SectionLabel } from "./SectionLabel";
import { SystemCard } from "./SystemCard";
import { actionRowClasses } from "./ui-styles";

interface ApprovalCardProps {
  request: ApprovalRequest;
  onDecide: (decision: "once" | "always" | "reject") => void;
}

/** Derive a short human-readable scope label that mirrors the server's generatePattern logic. */
function describeAlwaysScope(request: ApprovalRequest): string {
  const filePath = request.details?.file_path ?? request.details?.path;
  if (typeof filePath === "string") {
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash > 0) {
      const dirName = filePath.slice(0, lastSlash).split("/").pop();
      return `${dirName}/`;
    }
  }
  if (typeof request.details?.command === "string") {
    const cmd = String(request.details.command);
    const firstSpace = cmd.indexOf(" ");
    return firstSpace > 0 ? `${cmd.slice(0, firstSpace)} *` : cmd;
  }
  return request.toolName;
}

export function ApprovalCard({ request, onDecide }: ApprovalCardProps) {
  const scope = describeAlwaysScope(request);

  return (
    <SystemCard>
      <SectionLabel>Permission request</SectionLabel>
      <p className="mb-2 text-sm leading-6 text-text">
        <span className="font-semibold text-accent">{request.toolName}</span>
        {" wants "}
        <span className="font-medium">{request.permission}</span>
      </p>
      {request.description ? (
        <pre className="mb-4 whitespace-pre-wrap rounded-xl border border-border/10 bg-bg/34 px-3 py-2 font-mono text-xs leading-relaxed text-muted">
          {request.description}
        </pre>
      ) : null}
      <div className={`${actionRowClasses} flex-wrap justify-start`}>
        <Button size="sm" intent="ghost" onClick={() => onDecide("once")}>
          Once
        </Button>
        <Button size="sm" onClick={() => onDecide("always")}>
          Always in {scope}
        </Button>
        <Button size="sm" intent="danger" onClick={() => onDecide("reject")}>
          Reject
        </Button>
      </div>
    </SystemCard>
  );
}
