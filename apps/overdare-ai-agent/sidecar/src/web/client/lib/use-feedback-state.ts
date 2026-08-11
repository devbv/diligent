// @summary Explicit user feedback submission for the Web product surface

import { useCallback } from "react";
import {
  type FeedbackReportParams,
  FeedbackReportResponseSchema,
  WEB_FEEDBACK_REPORT_METHOD,
} from "../../shared/feedback-protocol";
import type { useRpcClient } from "./use-rpc";

type RpcClientResult = ReturnType<typeof useRpcClient>;

export const FEEDBACK_REPORT_TIMEOUT_MS = 10_000;

type FeedbackRpc = Pick<NonNullable<RpcClientResult["rpcRef"]["current"]>, "requestRaw">;

export async function submitFeedbackRpc(rpc: FeedbackRpc, params: FeedbackReportParams) {
  return FeedbackReportResponseSchema.parse(
    await rpc.requestRaw(WEB_FEEDBACK_REPORT_METHOD, params, FEEDBACK_REPORT_TIMEOUT_MS),
  );
}

export function useFeedbackState({ rpcRef }: { rpcRef: RpcClientResult["rpcRef"] }) {
  const submitFeedback = useCallback(
    async (params: FeedbackReportParams) => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("Not connected");
      return submitFeedbackRpc(rpc, params);
    },
    [rpcRef],
  );

  return {
    submitFeedback,
  };
}
