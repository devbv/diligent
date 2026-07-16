// @summary Inline chat card for agent user-input questions with text/password fields and always-on custom input

import type { UserInputRequest } from "@diligent/protocol";
import { memo, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../lib/cn";
import { isUserInputComplete } from "../lib/user-input-completeness";
import { AssetThumbnail } from "./AssetThumbnail";
import { Button } from "./Button";
import { Check } from "./icons";
import { SectionLabel } from "./SectionLabel";
import { SystemCard } from "./SystemCard";
import { actionRowClasses, cardPaddingLooseClasses, formStackClasses, surfaceCardClasses } from "./ui-styles";

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

function optionValue(option: { label: string; value?: string }): string {
  return option.value ?? option.label;
}

const choiceFocusRing =
  "peer-focus-visible:ring-choice peer-focus-visible:ring-control-choice/30 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-surface-dark";
const choiceMarkerBase =
  "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center border-choice transition-colors duration-150";
const uncheckedChoiceClasses =
  "border-control-choice-border bg-transparent text-transparent group-hover:border-control-choice-border-hover";
const checkedChoiceClasses = "border-control-choice bg-control-choice text-text shadow-choice";

function ChoiceMarker({ checked, allowMultiple }: { checked: boolean; allowMultiple: boolean }) {
  if (allowMultiple) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          choiceMarkerBase,
          choiceFocusRing,
          "rounded-sm",
          checked ? checkedChoiceClasses : uncheckedChoiceClasses,
        )}
      >
        {checked ? <Check aria-hidden="true" className="h-3 w-3" strokeWidth={3} /> : null}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        choiceMarkerBase,
        choiceFocusRing,
        "rounded-full",
        checked ? checkedChoiceClasses : uncheckedChoiceClasses,
      )}
    >
      {checked ? <span className="h-1.5 w-1.5 rounded-full bg-text" /> : null}
    </span>
  );
}

// Memoized so the streaming agent's per-token MessageList re-renders don't re-render the focused
// custom-answer input. Re-rendering a focused controlled input mid-typing makes the browser
// re-select its text (Ctrl+A-like) and breaks IME composition. QuestionCard's props are
// referentially stable during streaming, so a shallow prop comparison isolates it correctly.
export const QuestionCard = memo(function QuestionCard({
  request,
  answers,
  onAnswerChange,
  onSubmit,
  onCancel,
}: QuestionCardProps) {
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
        <div className={formStackClasses}>
          {request.questions.map((question) => {
            const rawSelected = answers[question.id];
            const selected = toStringArray(rawSelected);
            const hasOptions = question.options.length > 0;
            const allowMultiple = Boolean(question.allow_multiple);
            const selectedSet = new Set(selected);
            const isAsset = question.display === "asset";
            const customValue = selected.find((value) => !question.options.some((o) => optionValue(o) === value)) ?? "";

            return (
              <div key={question.id} className={`${surfaceCardClasses} ${cardPaddingLooseClasses}`}>
                <p className="mb-3 text-sm font-semibold leading-6 text-text">{question.question}</p>

                {isAsset ? (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {question.options.map((opt) => {
                      const val = optionValue(opt);
                      const checked = selectedSet.has(val);
                      const meta = opt.asset?.price ?? opt.description;
                      return (
                        <button
                          key={val}
                          type="button"
                          data-asset-value={val}
                          onClick={() => onAnswerChange(question.id, val)}
                          className={`flex flex-col gap-1.5 rounded-md border p-1.5 text-left transition ${
                            checked ? "border-accent bg-white/5" : "border-border/30 hover:bg-white/[.03]"
                          }`}
                        >
                          <span className="block h-[7rem] w-full overflow-hidden rounded bg-fill-secondary">
                            <AssetThumbnail
                              asset={{
                                title: opt.label,
                                subtitle: opt.asset?.subtitle ?? opt.description,
                                thumbnailUrl: opt.asset?.thumbnailUrl,
                                previewUrl: opt.asset?.previewUrl,
                              }}
                            />
                          </span>
                          <span className="block truncate text-sm text-text-soft">{opt.label}</span>
                          {meta ? <span className="block truncate text-xs text-muted">{meta}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : hasOptions ? (
                  <div className="space-y-1">
                    {question.options.map((opt, i) => {
                      const val = optionValue(opt);
                      const checked = selectedSet.has(val);
                      return (
                        <label
                          key={opt.label}
                          className={`group flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                            checked
                              ? "bg-fill-active text-text"
                              : "text-muted hover:bg-fill-ghost-hover hover:text-text"
                          }`}
                        >
                          <span className="w-4 shrink-0 pt-0.5 text-right font-mono text-xs opacity-40">{i + 1}</span>
                          <input
                            type={allowMultiple ? "checkbox" : "radio"}
                            name={question.id}
                            checked={checked}
                            onChange={() => {
                              if (allowMultiple) {
                                const next = checked ? selected.filter((v) => v !== val) : [...selected, val];
                                onAnswerChange(question.id, next);
                                return;
                              }
                              onAnswerChange(question.id, val);
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

                <div className={cn("flex gap-3", hasOptions ? "items-start px-3 py-2" : "items-center px-2 py-1")}>
                  {hasOptions ? (
                    <>
                      <span className="w-4 shrink-0 pt-0.5 text-right font-mono text-xs opacity-40">
                        {question.options.length + 1}
                      </span>
                      <span aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                    </>
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
                          question.options.some((o) => optionValue(o) === value),
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
        <div className={`mt-4 ${actionRowClasses}`}>
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
});
