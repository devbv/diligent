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

export function useConsentState({ rpcRef }: { rpcRef: RpcClientResult["rpcRef"] }) {
  const [consent, setConsent] = useState<ConsentState | null>(null);

  const updateConsent = useCallback(
    async (patch: ConsentSetParams) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      const next = ConsentStateSchema.parse(await rpc.requestRaw(WEB_CONSENT_SET_METHOD, patch));
      setConsent(next);
    },
    [rpcRef],
  );

  return {
    consent,
    setConsent,
    updateConsent,
  };
}
