// @summary Copy-to-clipboard button with transient "copied!" feedback

import { useState } from "react";
import { copyTextToClipboard } from "../lib/clipboard";
import { microLabelClasses } from "./ui-styles";

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className = "" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`rounded-md px-1.5 py-0.5 transition hover:bg-fill-ghost-hover hover:text-text ${microLabelClasses} ${className}`}
    >
      {copied ? "copied!" : "copy"}
    </button>
  );
}
