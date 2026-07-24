// @summary Markdown renderer using dangerouslySetInnerHTML with prose styles

import { type MouseEvent, useEffect, useRef } from "react";
import { copyTextToClipboard } from "../lib/clipboard";
import { cn } from "../lib/cn";
import { renderMarkdown } from "../lib/markdown";

interface MarkdownContentProps {
  text: string;
  className?: string;
}

export function MarkdownContent({ text, className }: MarkdownContentProps) {
  const resetTimers = useRef(new Map<HTMLButtonElement, number>());

  useEffect(
    () => () => {
      for (const timer of resetTimers.current.values()) {
        window.clearTimeout(timer);
      }
      resetTimers.current.clear();
    },
    [],
  );

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;

    const copyButton = event.target.closest<HTMLButtonElement>("[data-code-copy-button]");
    if (!copyButton || !event.currentTarget.contains(copyButton)) return;

    const code = copyButton.closest(".code-block")?.querySelector("pre code")?.textContent;
    if (code === undefined) return;

    void copyTextToClipboard(code).then((copied) => {
      if (!copied) return;

      const previousTimer = resetTimers.current.get(copyButton);
      if (previousTimer !== undefined) {
        window.clearTimeout(previousTimer);
      }

      copyButton.dataset.copied = "true";
      copyButton.setAttribute("aria-label", "Copied");

      const timer = window.setTimeout(() => {
        copyButton.dataset.copied = "false";
        copyButton.setAttribute("aria-label", copyButton.dataset.copyLabel ?? "Copy code");
        resetTimers.current.delete(copyButton);
      }, 1_000);
      resetTimers.current.set(copyButton, timer);
    });
  };

  return (
    <div
      className={cn("prose-content", className)}
      onClick={handleClick}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: agent output only — external input echoing requires DOMPurify
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}
