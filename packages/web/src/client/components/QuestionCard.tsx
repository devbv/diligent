// @summary Inline chat card for agent user-input questions with text/password fields and always-on custom input

import type { UserInputRequest } from "@diligent/protocol";
import { AssetThumbnail } from "./AssetThumbnail";
import { Button } from "./Button";
import { SectionLabel } from "./SectionLabel";
import { SystemCard } from "./SystemCard";

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

export function QuestionCard({ request, answers, onAnswerChange, onSubmit, onCancel }: QuestionCardProps) {
  return (
    <SystemCard>
      <SectionLabel>Input required</SectionLabel>
      <div className="space-y-5">
        {request.questions.map((question) => {
          const rawSelected = answers[question.id];
          const selected = toStringArray(rawSelected);
          const hasOptions = question.options.length > 0;
          const allowMultiple = Boolean(question.allow_multiple);
          const selectedSet = new Set(selected);
          const isAsset = question.display === "asset";
          const customValue = selected.find((value) => !question.options.some((o) => optionValue(o) === value)) ?? "";

          return (
            <div key={question.id} className="rounded-lg border border-border/100 bg-[#11131a] px-4 py-4">
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
                question.options.map((opt, i) => {
                  const val = optionValue(opt);
                  const checked = selectedSet.has(val);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => {
                        if (allowMultiple) {
                          const next = checked ? selected.filter((v) => v !== val) : [...selected, val];
                          onAnswerChange(question.id, next);
                          return;
                        }
                        onAnswerChange(question.id, val);
                      }}
                      className={`flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                        checked ? "bg-white/5 text-text" : "text-muted hover:bg-white/[.03] hover:text-text"
                      }`}
                    >
                      <span className="w-4 shrink-0 text-right font-mono text-xs opacity-40">{i + 1}</span>
                      <span className="shrink-0 font-mono text-xs">
                        {allowMultiple ? (checked ? "[x]" : "[ ]") : checked ? "(●)" : "( )"}
                      </span>
                      <span className="flex-1">{opt.label}</span>
                      {opt.description ? <span className="shrink-0 text-xs opacity-40">{opt.description}</span> : null}
                    </button>
                  );
                })
              ) : null}

              <div className="flex items-center gap-3 px-2 py-1">
                {hasOptions ? (
                  <span className="w-4 shrink-0 text-right font-mono text-xs opacity-40">
                    {question.options.length + 1}
                  </span>
                ) : null}
                <div className="flex flex-1 flex-col rounded-lg bg-transparent">
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
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onSubmit();
                    }}
                    className="bg-transparent text-sm text-text placeholder:text-muted/50 focus:outline-none"
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
        <Button size="sm" onClick={onSubmit}>
          Submit
        </Button>
      </div>
    </SystemCard>
  );
}
