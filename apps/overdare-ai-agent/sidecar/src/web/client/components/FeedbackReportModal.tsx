// @summary Panel-scoped message report dialog with retry-safe submission state

import { type FormEvent, type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import type { FeedbackCategory } from "../../shared/feedback-protocol";
import { type FeedbackReportTarget, formatFeedbackSubmitError } from "../lib/feedback-report";
import { createUuidV4 } from "../lib/uuid";
import { X } from "./icons";
import { Select, type SelectOption } from "./Select";

interface FeedbackReportModalProps {
  target: FeedbackReportTarget;
  onSubmit: (submission: FeedbackReportSubmission) => Promise<void>;
  onCancel: () => void;
}

export interface FeedbackReportSubmission {
  clientReportId: string;
  category: FeedbackCategory;
  description?: string;
}

const CATEGORY_OPTIONS: SelectOption[] = [
  { value: "stalled", label: "The response stopped" },
  { value: "error", label: "An error occurred" },
  { value: "etc", label: "Something else" },
];

function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-4 w-4 shrink-0 text-[#565f69]">
      <circle cx="8" cy="8" r="6.25" fill="currentColor" />
      <path d="M8 7.1v4.1M8 4.75v.1" stroke="#181b1f" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-4 w-4 shrink-0 text-[#ff8d18]">
      <path
        d="M7.13 2.3a1 1 0 0 1 1.74 0l5.56 9.9a1 1 0 0 1-.87 1.49H2.44a1 1 0 0 1-.87-1.49l5.56-9.9Z"
        fill="currentColor"
      />
      <path d="M8 5.4v4.1M8 11.8v.1" stroke="#181b1f" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function FeedbackReportModal({ target, onSubmit, onCancel }: FeedbackReportModalProps) {
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const clientReportIdRef = useRef<string | null>(null);
  const normalizedDescription = description.trim();
  const canSubmit = category !== null && !submitting;

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    if (!canSubmit || !category || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    clientReportIdRef.current ??= createUuidV4();
    try {
      await onSubmit({
        clientReportId: clientReportIdRef.current,
        category,
        ...(normalizedDescription ? { description: normalizedDescription } : {}),
      });
    } catch (cause) {
      setError(formatFeedbackSubmitError(cause));
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || submitting) return;
    event.preventDefault();
    onCancel();
  };

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !submitting) onCancel();
  };

  const handleCategoryChange = (value: string) => {
    const nextCategory = value as FeedbackCategory;
    if (nextCategory === category) return;
    clientReportIdRef.current = null;
    setError(null);
    setCategory(nextCategory);
  };

  const handleDescriptionInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const nextDescription = event.currentTarget.value;
    if (nextDescription !== description) {
      clientReportIdRef.current = null;
      setError(null);
    }
    setDescription(nextDescription);
  };

  return (
    <div
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-5"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-report-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="flex max-h-[calc(100%-40px)] w-[calc(100%-40px)] max-w-[390px] flex-col overflow-hidden rounded-xl border border-[#2a3038] bg-[#21262c] shadow-panel focus:outline-none"
      >
        <header className="flex h-12 shrink-0 items-center gap-4 px-4 pb-3 pt-4">
          <h2 id="feedback-report-title" className="min-w-0 flex-1 text-base font-bold leading-5 text-white">
            Report an issue
          </h2>
          <button
            type="button"
            title="Close report"
            disabled={submitting}
            onClick={onCancel}
            className="inline-flex h-4 w-4 items-center justify-center rounded text-[#dce2e8] transition hover:bg-[#2a3038] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-30"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Close report</span>
          </button>
        </header>

        <form onSubmit={handleFormSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
            <section className="flex flex-col gap-2">
              <div className="flex h-5 items-center justify-between gap-2">
                <h3 className="text-xs font-bold leading-4 text-white">Reporting this message</h3>
                <span className="rounded bg-[#2a3038] px-1 py-0.5 text-[10px] leading-3 text-[#88929c]">
                  {target.kind === "request" ? "Request" : "Response"}
                </span>
              </div>
              <div className="min-h-6 rounded bg-black/30 px-2 py-1 text-xs leading-4 text-[#dce2e8]">
                <p
                  className="overflow-hidden whitespace-pre-line break-words"
                  style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}
                >
                  {target.preview || "No response yet"}
                </p>
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <h3 id="feedback-report-category-label" className="text-xs font-bold leading-4 text-white">
                Issue type
              </h3>
              <Select
                ariaLabelledBy="feedback-report-category-label"
                triggerId="feedback-report-category"
                value={category ?? ""}
                placeholder="Select a type"
                options={CATEGORY_OPTIONS}
                disabled={submitting}
                onChange={handleCategoryChange}
                triggerClassName="h-6 rounded border-0 bg-black px-2 text-xs text-[#dce2e8] ring-offset-[#21262c]"
                menuClassName="mt-1 rounded border-[#2a3038] bg-[#111316] shadow-none"
                menuListClassName="py-0"
                optionClassName="h-6 rounded-sm px-2 py-1 text-xs leading-4 text-[#dce2e8]"
              />
            </section>

            <section className="flex flex-col gap-2">
              <label htmlFor="feedback-report-description" className="text-xs font-bold leading-4 text-white">
                Details (optional)
              </label>
              <div className="flex flex-col gap-1">
                <textarea
                  id="feedback-report-description"
                  rows={3}
                  maxLength={1000}
                  disabled={submitting}
                  placeholder="What went wrong?"
                  value={description}
                  onInput={handleDescriptionInput}
                  className="h-16 resize-none overflow-y-auto rounded bg-black px-2 py-1 text-xs leading-4 text-[#dce2e8] placeholder:text-[#88929c] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span className="text-right text-[10px] leading-3 text-[#88929c]">{description.length} / 1000</span>
              </div>
            </section>

            <div className="flex min-h-[52px] items-start gap-1 rounded-lg bg-[#181b1f] px-2.5 py-2">
              <InfoIcon />
              <p className="text-[10px] leading-3 text-[#565f69]">
                Session and message identifiers are sent with this report so we can investigate.
              </p>
            </div>

            {error ? (
              <div
                className="flex min-h-8 items-center gap-1 rounded-lg bg-[#181b1f] px-2.5 py-2 text-[#ff8d18]"
                role="alert"
              >
                <WarningIcon />
                <p className="text-[10px] leading-3">{error}</p>
              </div>
            ) : null}
          </div>

          <footer className="flex h-[72px] shrink-0 items-start justify-end px-4 py-4">
            <button
              type="submit"
              disabled={!canSubmit}
              className="h-10 w-[104px] rounded-lg border border-[#64afff] bg-[#3191ff] text-sm font-bold leading-5 text-white transition hover:bg-[#64afff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-30"
            >
              {submitting ? "Submitting…" : "Submit"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
