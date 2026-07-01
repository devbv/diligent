// @summary Consent state hook: manages consent data and updateConsent RPC callback
import type { ConsentSetParams, ConsentState } from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import { useCallback, useState } from "react";
import type { useRpcClient } from "./use-rpc";

type RpcClientResult = ReturnType<typeof useRpcClient>;

export function useConsentState({ rpcRef }: { rpcRef: RpcClientResult["rpcRef"] }) {
  const [consent, setConsent] = useState<ConsentState | null>(null);

  const updateConsent = useCallback(
    async (patch: ConsentSetParams) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      const next = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.CONSENT_SET, patch);
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
