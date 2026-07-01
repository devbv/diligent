// @summary Assistant message with left decoration bar, agent icon, thinking block, and markdown content

import { useState } from "react";
import type { RenderItem } from "../lib/thread-store";
import {
  AssistantContentBlocks,
  isRenderableAssistantContentBlock,
  isToolLikeAssistantContentBlock,
} from "./AssistantContentBlocks";
import { MarkdownContent } from "./MarkdownContent";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolActivityRow } from "./ToolActivityRow";

function formatMs(ms?: number): string | null {
  if (ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

interface AssistantMessageProps {
  item: Extract<RenderItem, { kind: "assistant" }>;
  suppressThinking?: boolean;
}

interface SkillUsageNotice {
  skillName: string;
  workArea: string | null;
  details: Array<{ label: string; value: string }>;
  remainingText: string;
}

type AssistantContentBlock = Extract<RenderItem, { kind: "assistant" }>["contentBlocks"][number];

const SKILL_USAGE_LABELS = new Set([
  "Skill used",
  "Work area",
  "Classification rationale",
  "Reproduction path",
  "Reference cases",
  "Goal for this loop",
  "First checks",
]);

function parseSkillUsageLine(line: string): { label: string; value: string } | null {
  const match = line.match(/^([A-Za-z][A-Za-z ]+):\s*(.*)$/);
  if (!match) return null;

  const label = match[1]?.trim() ?? "";
  if (!SKILL_USAGE_LABELS.has(label)) return null;

  return { label, value: match[2]?.trim() ?? "" };
}

function extractSkillUsageNotice(text: string): SkillUsageNotice | null {
  const trimmedStart = text.trimStart();
  const lines = trimmedStart.split(/\r?\n/);
  const first = parseSkillUsageLine(lines[0] ?? "");
  if (!first || first.label !== "Skill used" || !first.value) return null;

  const entries: Array<{ label: string; value: string }> = [first];
  let consumedLines = 1;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      consumedLines = index + 1;
      break;
    }

    const parsed = parseSkillUsageLine(line);
    if (!parsed) {
      consumedLines = index;
      break;
    }

    entries.push(parsed);
    consumedLines = index + 1;
  }

  const workArea = entries.find((entry) => entry.label === "Work area")?.value ?? null;
  const details = entries.filter((entry) => entry.label !== "Skill used" && entry.label !== "Work area");
  const remainingText = lines.slice(consumedLines).join("\n").trimStart();

  return {
    skillName: first.value,
    workArea,
    details,
    remainingText,
  };
}

function extractFirstContentBlockSkillUsage(blocks: AssistantContentBlock[]): SkillUsageNotice | null {
  for (const block of blocks) {
    if (block.type !== "text") continue;
    const notice = extractSkillUsageNotice(block.text);
    if (notice) return notice;
  }
  return null;
}

function stripSkillUsageFromContentBlocks(
  blocks: AssistantContentBlock[],
  shouldStrip: boolean,
): AssistantContentBlock[] {
  if (!shouldStrip) return blocks;

  let strippedFirstNotice = false;
  return blocks.flatMap((block) => {
    if (strippedFirstNotice || block.type !== "text") return [block];

    const notice = extractSkillUsageNotice(block.text);
    if (!notice) return [block];

    strippedFirstNotice = true;
    if (!notice.remainingText.trim()) return [];
    return [{ ...block, text: notice.remainingText }];
  });
}

function SkillUsageRow({ notice }: { notice: SkillUsageNotice }) {
  const [open, setOpen] = useState(false);
  const expandable = notice.details.length > 0;

  return (
    <div className="mb-1">
      <ToolActivityRow
        title={`Skill used: ${notice.skillName}`}
        icon="book"
        category="context"
        status="done"
        isError={false}
        isBusy={false}
        durationLabel={null}
        metaLabel={notice.workArea}
        metaTone="muted"
        expanded={open}
        expandable={expandable}
        compact={true}
        onToggle={() => setOpen((value) => !value)}
      />

      {open ? (
        <div className="ml-7 mt-0.5 max-w-tool-row space-y-1 text-xs leading-5 text-muted/80">
          {notice.details.map((detail) => (
            <div key={detail.label} className="min-w-0">
              <span className="text-muted/60">{detail.label}: </span>
              <span className="break-words text-text-secondary">{detail.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AssistantMessage({ item, suppressThinking = false }: AssistantMessageProps) {
  const hasThinking = item.thinking.length > 0;
  const hasText = item.text.length > 0;
  const skillNotice =
    (hasText ? extractSkillUsageNotice(item.text) : null) ?? extractFirstContentBlockSkillUsage(item.contentBlocks);
  const visibleText = skillNotice?.remainingText ?? item.text;
  const hasVisibleText = visibleText.length > 0;
  const contentBlocks = stripSkillUsageFromContentBlocks(item.contentBlocks, Boolean(skillNotice));
  const renderableContentBlocks = contentBlocks.filter(isRenderableAssistantContentBlock);
  const hasStructuredBlocks = renderableContentBlocks.length > 0;
  const hasToolLikeBlocks = renderableContentBlocks.some(isToolLikeAssistantContentBlock);
  const turnDuration = formatMs(item.turnDurationMs);
  const reasoningDuration = formatMs(item.reasoningDurationMs);
  const showTurnFooter = item.thinkingDone && !hasToolLikeBlocks && Boolean(turnDuration);

  if (!hasThinking && !hasText && !hasStructuredBlocks) return null;

  return (
    <div className="pb-1">
      {hasThinking && !suppressThinking && (
        <div className="pb-3">
          <ThinkingBlock
            text={item.thinking}
            streaming={!item.thinkingDone}
            duration={item.thinkingDone ? reasoningDuration : null}
          />
        </div>
      )}
      {skillNotice ? <SkillUsageRow notice={skillNotice} /> : null}
      {hasStructuredBlocks ? (
        <AssistantContentBlocks blocks={contentBlocks} />
      ) : hasVisibleText ? (
        <MarkdownContent text={visibleText} />
      ) : null}
      {showTurnFooter ? (
        <div className="pt-1 text-xs uppercase tracking-wide text-muted/65">
          <span>{`Completed in ${turnDuration}`}</span>
        </div>
      ) : null}
    </div>
  );
}
