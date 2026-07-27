// @summary Account identity state and explicit user feedback submission for the Web product surface

import { useCallback, useState } from "react";
import {
  type FeedbackReportParams,
  FeedbackReportResponseSchema,
  WEB_FEEDBACK_REPORT_METHOD,
} from "../../shared/feedback-protocol";
import type { useRpcClient } from "./use-rpc";

type RpcClientResult = ReturnType<typeof useRpcClient>;

export function useFeedbackState({ rpcRef }: { rpcRef: RpcClientResult["rpcRef"] }) {
  const [accountId, setAccountId] = useState("");

  const submitFeedback = useCallback(
    async (params: FeedbackReportParams) => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("Not connected");
      return FeedbackReportResponseSchema.parse(await rpc.requestRaw(WEB_FEEDBACK_REPORT_METHOD, params));
    },
    [rpcRef],
  );

  return {
    accountId,
    setAccountId,
    submitFeedback,
  };
}
