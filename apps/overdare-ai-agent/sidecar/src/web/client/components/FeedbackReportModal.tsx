// @summary Modal for reporting one conversation with server-correlated diagnostic identifiers

import { useState } from "react";
import { Button } from "./Button";
import { DiagnosticIdentifiers } from "./DiagnosticIdentifiers";
import { Modal } from "./Modal";
import { TextArea } from "./TextArea";
import { actionRowClasses } from "./ui-styles";

interface FeedbackReportModalProps {
  sessionId: string;
  accountId?: string | null;
  onSubmit: (feedback: string) => Promise<void>;
  onCancel: () => void;
}

export function FeedbackReportModal({ sessionId, accountId, onSubmit, onCancel }: FeedbackReportModalProps) {
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedFeedback = feedback.trim();
  const canSubmit = Boolean(accountId?.trim()) && normalizedFeedback.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(normalizedFeedback);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to submit report");
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Report conversation"
      description="Describe what went wrong. The account and session IDs below are included so support can find the related logs."
      onCancel={submitting ? undefined : onCancel}
      onConfirm={canSubmit ? handleSubmit : undefined}
    >
      <div className="space-y-4">
        <DiagnosticIdentifiers sessionId={sessionId} accountId={accountId} />

        <div className="space-y-1.5">
          <label htmlFor="feedback-report-text" className="block text-sm font-medium text-text">
            Feedback
          </label>
          <TextArea
            id="feedback-report-text"
            autoFocus
            maxRows={8}
            maxLength={4000}
            placeholder="Tell us what happened and what you expected."
            value={feedback}
            onInput={(event) => setFeedback(event.currentTarget.value)}
          />
          <span className="block text-right text-xs text-muted">{feedback.length}/4000</span>
        </div>

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}

        {!accountId?.trim() ? (
          <output className="block text-sm text-warning">
            Account ID is unavailable. Reconnect the app before submitting a report.
          </output>
        ) : null}

        <div className={actionRowClasses}>
          <Button intent="ghost" size="sm" disabled={submitting} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {submitting ? "Submitting…" : "Submit report"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
