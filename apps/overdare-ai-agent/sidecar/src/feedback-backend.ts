// @summary Provides the Web feedback backend over the authenticated gateway transport

import { postUserFeedback } from "./tools/gateway/feedback";
import type { FeedbackReportInput, FeedbackReportResponse, WebFeedbackBackend } from "./web/shared/feedback-protocol";

interface FeedbackBackendOptions {
  postReport?: (report: FeedbackReportInput) => Promise<FeedbackReportResponse>;
}

export function createFeedbackBackend(options: FeedbackBackendOptions = {}): WebFeedbackBackend {
  const postReport = options.postReport ?? postUserFeedback;

  return {
    submit: postReport,
  };
}
