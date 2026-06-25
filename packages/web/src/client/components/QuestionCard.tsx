// @summary Inline chat card for agent user-input questions with text/password fields and always-on custom input

import type { UserInputRequest } from "@diligent/protocol";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../lib/cn";
import { isUserInputComplete } from "../lib/user-input-completeness";
import { Button } from "./Button";
import { SectionLabel } from "./SectionLabel";
import { SystemCard } from "./SystemCard";

export { isQuestionAnswered, isUserInputComplete } from "../lib/user-input-completeness";

interface QuestionCardProps {
  request: UserInputRequest;
  answers: Record<string, string | string[]>;
  onAnswerChange: (id: string, value: string | string[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function toStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) return [value];
  return [];
}

function ChoiceMarker({ checked, allowMultiple }: { checked: boolean; allowMultiple: boolean }) {
  if (allowMultiple) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[13px] font-semibold leading-none transition peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#11131a]",
          checked
            ? "border-success bg-success text-bg shadow-[0_0_0_1px_rgba(34,197,94,0.25)]"
            : "border-border-strong/100 bg-transparent text-transparent",
        )}
      >
        {checked ? "✓" : ""}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#11131a]",
        checked ? "border-accent" : "border-border-strong/100",
      )}
    >
      {checked ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
    </span>
  );
}

export function QuestionCard({ request, answers, onAnswerChange, onSubmit, onCancel }: QuestionCardProps) {
  const canSubmit = isUserInputComplete(request, answers);
  const submitIfComplete = () => {
    if (!canSubmit) return;
    onSubmit();
  };
  const stopInputEnter = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    const shouldPrevent =
      typeof HTMLInputElement !== "undefined" &&
      e.target instanceof HTMLInputElement &&
      (e.target.type === "text" || e.target.type === "password");
    if (!shouldPrevent) return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <SystemCard>
      <div onKeyDownCapture={stopInputEnter}>
        <SectionLabel>Input required</SectionLabel>
        <div className="space-y-5">
          {request.questions.map((question) => {
            const rawSelected = answers[question.id];
            const selected = toStringArray(rawSelected);
            const hasOptions = question.options.length > 0;
            const allowMultiple = Boolean(question.allow_multiple);
            const selectedSet = new Set(selected);
            const customValue = selected.find((value) => !question.options.some((o) => o.label === value)) ?? "";

            return (
              <div key={question.id} className="rounded-lg border border-border/100 bg-[#11131a] px-4 py-4">
                <p className="mb-3 text-sm font-semibold leading-6 text-text">{question.question}</p>

                {hasOptions ? (
                  <div className="space-y-1">
                    {question.options.map((opt, i) => {
                      const checked = selectedSet.has(opt.label);
                      return (
                        <label
                          key={opt.label}
                          className={`flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                            checked ? "bg-white/5 text-text" : "text-muted hover:bg-white/[.03] hover:text-text"
                          }`}
                        >
                          <span className="w-4 shrink-0 pt-0.5 text-right font-mono text-xs opacity-40">{i + 1}</span>
                          <input
                            type={allowMultiple ? "checkbox" : "radio"}
                            name={question.id}
                            checked={checked}
                            onChange={() => {
                              if (allowMultiple) {
                                const next = checked
                                  ? selected.filter((v) => v !== opt.label)
                                  : [...selected, opt.label];
                                onAnswerChange(question.id, next);
                                return;
                              }
                              onAnswerChange(question.id, opt.label);
                            }}
                            className="peer sr-only"
                          />
                          <ChoiceMarker checked={checked} allowMultiple={allowMultiple} />
                          <span className="min-w-0 flex-1">
                            <span className="block break-words">{opt.label}</span>
                            {opt.description ? (
                              <span className="mt-0.5 block break-words text-xs opacity-50">{opt.description}</span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : null}

                <div className="flex items-center gap-3 px-2 py-1">
                  {hasOptions ? (
                    <span className="w-4 shrink-0 text-right font-mono text-xs opacity-40">
                      {question.options.length + 1}
                    </span>
                  ) : null}
                  <div className="flex min-w-0 flex-1 flex-col rounded-lg bg-transparent">
                    <input
                      id={question.id}
                      aria-label={question.header}
                      type={question.is_secret ? "password" : "text"}
                      placeholder={hasOptions ? "or type a custom answer…" : "Type your answer…"}
                      value={customValue}
                      onChange={(e) => {
                        const typed = e.target.value;
                        const optionSelected = selected.filter((value) =>
                          question.options.some((o) => o.label === value),
                        );
                        if (typed.length === 0) {
                          onAnswerChange(question.id, allowMultiple ? optionSelected : (optionSelected[0] ?? ""));
                          return;
                        }
                        onAnswerChange(question.id, allowMultiple ? [...optionSelected, typed] : typed);
                      }}
                      className="min-w-0 truncate bg-transparent text-sm text-text placeholder:text-muted/50 focus:outline-none"
                    />
                    <div className="border-b border-border/10 pt-1" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button size="sm" intent="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={submitIfComplete} disabled={!canSubmit} aria-disabled={!canSubmit}>
            Submit
          </Button>
        </div>
      </div>
    </SystemCard>
  );
}
