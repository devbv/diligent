// @summary Auto-resizing textarea capped at maxRows, Shift+Enter for newlines

import { type TextareaHTMLAttributes, useLayoutEffect, useRef } from "react";
import { cn } from "../lib/cn";
import { fieldClasses } from "./ui-styles";

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  maxRows?: number;
  unstyled?: boolean;
}

export function TextArea({ maxRows = 6, unstyled = false, className, onChange, value, ...props }: TextAreaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const lineHeight = 24;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * maxRows)}px`;
  });

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      className={cn(
        "resize-none overflow-y-auto",
        unstyled ? "w-full rounded-md px-3 py-2 text-sm text-text placeholder:text-text-subtle" : fieldClasses,
        className,
      )}
      onChange={onChange}
      {...props}
    />
  );
}
