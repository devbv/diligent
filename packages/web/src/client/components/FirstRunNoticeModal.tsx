// @summary First-run AI-data notice popup (OVDR-11475 §3.A): one-time acknowledgement + privacy-policy link

import { Button } from "./Button";
import { Modal } from "./Modal";

interface FirstRunNoticeModalProps {
  privacyPolicyUrl: string;
  /** Acknowledge the notice (consent/set { noticeAcknowledged: true }). */
  onGetStarted: () => void | Promise<void>;
}

/**
 * Shown once on first agent launch. [Get started] is an acknowledgement of the notice only —
 * it does NOT imply model-training consent (those live as toggles in Settings → AI Data).
 */
export function FirstRunNoticeModal({ privacyPolicyUrl, onGetStarted }: FirstRunNoticeModalProps) {
  return (
    <Modal title="Your data & AI" onConfirm={onGetStarted}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          To improve the AI agent, your conversations may be used to enhance the service. You can review and change
          these choices anytime in Settings → AI Data. Sensitive information is handled according to our privacy policy.
        </p>

        <div className="flex items-center justify-between gap-3">
          <a
            href={privacyPolicyUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-text-soft underline underline-offset-2 hover:text-text"
          >
            Privacy Policy
          </a>
          <Button
            intent="primary"
            className="!bg-blue-600 hover:!bg-blue-700 focus-visible:!ring-blue-500"
            onClick={() => void onGetStarted()}
          >
            Get started
          </Button>
        </div>
      </div>
    </Modal>
  );
}
