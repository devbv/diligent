// @summary Response report modal with required category and collapsed diagnostics

import { useRef, useState } from "react";
import type { FeedbackCategory } from "../../shared/feedback-protocol";
import type { FeedbackReportTarget } from "../lib/feedback-report";
import { Button } from "./Button";
import { DiagnosticIdentifiers } from "./DiagnosticIdentifiers";
import { Modal } from "./Modal";
import { TextArea } from "./TextArea";
import { actionRowClasses } from "./ui-styles";

interface FeedbackReportModalProps {
  sessionId: string;
  accountId?: string | null;
  target: FeedbackReportTarget;
  onSubmit: (submission: FeedbackReportSubmission) => Promise<void>;
  onCancel: () => void;
}

export interface FeedbackReportSubmission {
  category: FeedbackCategory;
  description?: string;
}

const CATEGORY_OPTIONS: Array<{ value: FeedbackCategory; label: string }> = [
  { value: "launch_fail", label: "Agent won't start" },
  { value: "interrupted", label: "Stopped during a task" },
  { value: "no_response", label: "No response" },
  { value: "wrong_result", label: "Incorrect result" },
  { value: "etc", label: "Other" },
];

export function FeedbackReportModal({ sessionId, accountId, target, onSubmit, onCancel }: FeedbackReportModalProps) {
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const normalizedDescription = description.trim();
  const canSubmit = Boolean(accountId?.trim()) && category !== null && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || !category || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        category,
        ...(normalizedDescription ? { description: normalizedDescription } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't submit the report. Please try again.");
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Report response"
      description="Tell us what went wrong with this response."
      onCancel={submitting ? undefined : onCancel}
      onConfirm={canSubmit ? handleSubmit : undefined}
    >
      <div className="space-y-4">
        <div className="rounded-md border border-border/60 bg-surface-light px-3 py-2">
          <div className="mb-1 text-xs font-medium text-muted">Reported response</div>
          <div className="max-h-10 overflow-hidden whitespace-pre-line text-sm leading-5 text-text-secondary">
            {target.preview}
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
            Description <span className="font-normal text-muted">(optional)</span>
          </label>
          <TextArea
            id="feedback-report-description"
            maxRows={8}
            maxLength={1000}
            disabled={submitting}
            placeholder="Tell us what happened"
            value={description}
            onInput={(event) => setDescription(event.currentTarget.value)}
          />
          <span className="block text-right text-xs text-muted">{description.length}/1000</span>
        </div>

        <div className="space-y-2 text-xs text-muted">
          <p>Session ID, app version, and other diagnostic information will be sent with your report.</p>
          <details>
            <summary className="cursor-pointer select-none font-medium text-text-secondary">View details</summary>
            <div className="mt-2 space-y-2">
              <DiagnosticIdentifiers sessionId={sessionId} accountId={accountId} />
              <div className="rounded-md border border-border/60 bg-surface-light px-3 py-2">
                <div className="break-all">Message ID: {target.messageId}</div>
                <div className="break-all">Occurred at: {target.occurredAt}</div>
                {target.agentModel ? <div className="break-all">Agent model: {target.agentModel}</div> : null}
              </div>
            </div>
          </details>
        </div>

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}

        {!accountId?.trim() ? (
          <output className="block text-sm text-warning">
            Account information is unavailable. Reconnect the app and try again.
          </output>
        ) : null}

        <div className={actionRowClasses}>
          <Button intent="ghost" size="sm" disabled={submitting} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {submitting ? "Submitting…" : "Report"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
