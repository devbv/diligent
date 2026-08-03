// @summary Consent state hook: manages consent data and updateConsent RPC callback
import { useCallback, useState } from "react";
import {
  type ConsentSetParams,
  type ConsentState,
  ConsentStateSchema,
  WEB_CONSENT_SET_METHOD,
} from "../../shared/consent-protocol";
import type { useRpcClient } from "./use-rpc";

type RpcClientResult = ReturnType<typeof useRpcClient>;
type NoticeStorage = Pick<Storage, "getItem" | "setItem">;

export const FIRST_RUN_NOTICE_ACKNOWLEDGED_KEY = "overdare:first-run-ai-data-notice-acknowledged:v1";

function browserStorage(): NoticeStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readFirstRunNoticeAcknowledged(storage: NoticeStorage | undefined = browserStorage()): boolean {
  try {
    return storage?.getItem(FIRST_RUN_NOTICE_ACKNOWLEDGED_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeFirstRunNoticeAcknowledged(storage: NoticeStorage | undefined = browserStorage()): void {
  try {
    storage?.setItem(FIRST_RUN_NOTICE_ACKNOWLEDGED_KEY, "true");
  } catch {
    // Browser privacy settings may block storage. Keep the in-memory acknowledgement below.
  }
}

export function useConsentState({ rpcRef }: { rpcRef: RpcClientResult["rpcRef"] }) {
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [noticeAcknowledgedLocally, setNoticeAcknowledgedLocally] = useState(readFirstRunNoticeAcknowledged);

  const updateConsent = useCallback(
    async (patch: ConsentSetParams) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      const next = ConsentStateSchema.parse(await rpc.requestRaw(WEB_CONSENT_SET_METHOD, patch));
      setConsent(next);
    },
    [rpcRef],
  );

  const acknowledgeNotice = useCallback(() => {
    writeFirstRunNoticeAcknowledged();
    setNoticeAcknowledgedLocally(true);
  }, []);

  return {
    consent,
    setConsent,
    updateConsent,
    noticeAcknowledgedLocally,
    acknowledgeNotice,
  };
}
