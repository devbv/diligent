// @summary Coordinates accepted feedback reports with non-blocking analytics

import { trackAgentBugReport } from "./tools/analytics";
import { postUserFeedback } from "./tools/gateway/feedback";
import type {
  FeedbackCategory,
  FeedbackReportInput,
  FeedbackReportResponse,
  WebFeedbackBackend,
} from "./web/shared/feedback-protocol";

interface AgentBugReportEvent {
  accountId: string;
  category: FeedbackCategory;
  sessionId: string;
}

interface FeedbackBackendOptions {
  postReport?: (report: FeedbackReportInput) => Promise<FeedbackReportResponse>;
  trackReport?: (event: AgentBugReportEvent) => Promise<void>;
}

export function createFeedbackBackend(options: FeedbackBackendOptions = {}): WebFeedbackBackend {
  const postReport = options.postReport ?? postUserFeedback;
  const trackReport = options.trackReport ?? trackAgentBugReport;

  return {
    async submit(report) {
      const receipt = await postReport(report);
      try {
        void trackReport({
          accountId: report.accountId,
          category: report.category,
          sessionId: report.sessionId,
        }).catch(() => {});
      } catch {
        // Analytics must not change the result of an already accepted report.
      }
      return receipt;
    },
  };
}
