// @summary Message report modal with a required category and retry-safe client report id

import { useRef, useState } from "react";
import type { FeedbackCategory } from "../../shared/feedback-protocol";
import { type FeedbackReportTarget, formatFeedbackSubmitError } from "../lib/feedback-report";
import { createUuidV4 } from "../lib/uuid";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { TextArea } from "./TextArea";
import { actionRowClasses } from "./ui-styles";

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

const CATEGORY_OPTIONS: Array<{ value: FeedbackCategory; label: string }> = [
  { value: "stalled", label: "The response stopped" },
  { value: "error", label: "An error occurred" },
  { value: "etc", label: "Something else" },
];

export function FeedbackReportModal({ target, onSubmit, onCancel }: FeedbackReportModalProps) {
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const clientReportIdRef = useRef<string | null>(null);
  const normalizedDescription = description.trim();
  const canSubmit = category !== null && !submitting;

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

  return (
    <Modal
      title="Report an issue"
      description="Tell us what went wrong with this message."
      onCancel={submitting ? undefined : onCancel}
      onConfirm={canSubmit ? handleSubmit : undefined}
    >
      <div className="space-y-4">
        <div className="rounded-md border border-border/60 bg-surface-light px-3 py-2">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted">
            <span>Reporting this message</span>
            <span className="rounded-full border border-border/60 px-2 py-0.5 text-text-secondary">
              {target.kind === "request" ? "Request" : "Response"}
            </span>
          </div>
          <div className="max-h-10 overflow-hidden whitespace-pre-line text-sm leading-5 text-text-secondary">
            {target.preview || "No response yet"}
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text">Issue type</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {CATEGORY_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-surface-light px-3 py-2 text-sm text-text-secondary transition hover:border-border-strong/100"
              >
                <input
                  type="radio"
                  name="feedback-category"
                  value={option.value}
                  checked={category === option.value}
                  disabled={submitting}
                  onChange={() => setCategory(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-1.5">
          <label htmlFor="feedback-report-description" className="block text-sm font-medium text-text">
            Details <span className="font-normal text-muted">(optional)</span>
          </label>
          <TextArea
            id="feedback-report-description"
            maxRows={8}
            maxLength={1000}
            disabled={submitting}
            placeholder="What went wrong?"
            value={description}
            onInput={(event) => setDescription(event.currentTarget.value)}
          />
          <span className="block text-right text-xs text-muted">{description.length}/1000</span>
        </div>

        <p className="text-xs text-muted">
          Session and message identifiers are sent with this report so we can investigate.
        </p>

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className={actionRowClasses}>
          <Button intent="ghost" size="sm" disabled={submitting} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {submitting ? "Submitting…" : "Submit"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
