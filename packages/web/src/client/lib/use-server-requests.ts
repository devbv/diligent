// @summary React hook for server-driven approval and user-input prompt state and resolution
import type {
  DiligentServerNotification,
  DiligentServerRequest,
  DiligentServerRequestResponse,
  UserInputRequest,
} from "@diligent/protocol";
import { DILIGENT_SERVER_NOTIFICATION_METHODS, DILIGENT_SERVER_REQUEST_METHODS } from "@diligent/protocol";
import type { RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import type { WebRpcClient } from "./rpc-client";
import { isUserInputComplete, type UserInputAnswers } from "./user-input-completeness";

interface BufferedServerRequest {
  requestId: number;
  request: DiligentServerRequest;
}

type UserInputServerRequest = Extract<
  DiligentServerRequest,
  { method: typeof DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST }
>;

export interface ResolveQuestionOptions {
  allowIncomplete?: boolean;
}

export function useServerRequests(
  rpcRef: RefObject<WebRpcClient | null>,
  activeThreadIdRef?: RefObject<string | null>,
  onAttention?: (threadId: string) => void,
  onBackgroundServerRequest?: (requestId: number, request: DiligentServerRequest) => void,
) {
  const [approvalPrompt, setApprovalPrompt] = useState<{
    requestId: number;
    request: DiligentServerRequest;
  } | null>(null);
  const [questionPrompt, setQuestionPrompt] = useState<{
    requestId: number;
    request: UserInputRequest;
  } | null>(null);
  const [answers, setAnswers] = useState<UserInputAnswers>({});

  const approvalRef = useRef<{ requestId: number; request: DiligentServerRequest } | null>(null);
  const questionRef = useRef<{ requestId: number; request: UserInputServerRequest } | null>(null);
  const bufferedRef = useRef<Map<string, BufferedServerRequest>>(new Map());

  const dismissBuffered = useCallback(
    (entry: BufferedServerRequest): void => {
      if (entry.request.method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST) {
        rpcRef.current?.respondServerRequest(entry.requestId, {
          method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
          result: { decision: "reject" },
        });
      } else {
        rpcRef.current?.respondServerRequest(entry.requestId, {
          method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
          result: { answers: {} },
        } as DiligentServerRequestResponse);
      }
    },
    [rpcRef],
  );

  const rejectPendingApproval = useCallback((): void => {
    const prev = approvalRef.current;
    if (prev) {
      rpcRef.current?.respondServerRequest(prev.requestId, {
        method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
        result: { decision: "reject" },
      });
      approvalRef.current = null;
    }
  }, [rpcRef]);

  const handleServerRequest = useCallback(
    (requestId: number, request: DiligentServerRequest): void => {
      const threadId = request.params?.threadId;

      onBackgroundServerRequest?.(requestId, request);

      if (threadId && activeThreadIdRef?.current && threadId !== activeThreadIdRef.current) {
        const prev = bufferedRef.current.get(threadId);
        if (prev) {
          dismissBuffered(prev);
        }
        bufferedRef.current.set(threadId, { requestId, request });
        onAttention?.(threadId);
        return;
      }

      if (request.method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST) {
        rejectPendingApproval();
        approvalRef.current = { requestId, request };
        setApprovalPrompt({ requestId, request });
        return;
      }
      questionRef.current = { requestId, request };
      setAnswers({});
      setQuestionPrompt({ requestId, request: request.params.request });
    },
    [activeThreadIdRef, dismissBuffered, rejectPendingApproval, onAttention, onBackgroundServerRequest],
  );

  const handleNotification = useCallback((notification: DiligentServerNotification): void => {
    if (notification.method !== DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED) {
      return;
    }

    const requestId = notification.params.requestId;

    if (approvalRef.current?.requestId === requestId) {
      approvalRef.current = null;
    }
    if (questionRef.current?.requestId === requestId) {
      questionRef.current = null;
    }
    setApprovalPrompt((current) => (current?.requestId === requestId ? null : current));
    setQuestionPrompt((current) => (current?.requestId === requestId ? null : current));

    for (const [tid, entry] of bufferedRef.current) {
      if (entry.requestId === requestId) {
        bufferedRef.current.delete(tid);
        break;
      }
    }
  }, []);

  const resolveApproval = useCallback(
    (decision: "once" | "always" | "reject"): void => {
      const current = approvalRef.current;
      if (!current) return;
      rpcRef.current?.respondServerRequest(current.requestId, {
        method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
        result: { decision },
      });
      approvalRef.current = null;
      setApprovalPrompt(null);
    },
    [rpcRef],
  );

  const resolveQuestion = useCallback(
    (respondAnswers: UserInputAnswers, options: ResolveQuestionOptions = {}): boolean => {
      const current = questionRef.current;
      if (!current) return false;
      const complete = isUserInputComplete(current.request.params.request, respondAnswers);
      if (!options.allowIncomplete && !complete) return false;
      rpcRef.current?.respondServerRequest(current.requestId, {
        method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
        result: { answers: respondAnswers },
      } as DiligentServerRequestResponse);
      questionRef.current = null;
      setQuestionPrompt(null);
      return true;
    },
    [rpcRef],
  );

  const shelveActivePrompts = useCallback((): void => {
    const prevApproval = approvalRef.current;
    if (prevApproval) {
      const tid = prevApproval.request.params?.threadId;
      if (tid) bufferedRef.current.set(tid, prevApproval);
      approvalRef.current = null;
      setApprovalPrompt(null);
    }
    const prevQuestion = questionRef.current;
    if (prevQuestion) {
      const tid = prevQuestion.request.params?.threadId;
      if (tid) bufferedRef.current.set(tid, prevQuestion);
      questionRef.current = null;
      setQuestionPrompt(null);
    }
  }, []);

  const activateThread = useCallback(
    (threadId: string): void => {
      shelveActivePrompts();

      const buffered = bufferedRef.current.get(threadId);
      if (!buffered) return;

      bufferedRef.current.delete(threadId);

      if (buffered.request.method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST) {
        approvalRef.current = buffered;
        setApprovalPrompt(buffered);
      } else {
        questionRef.current = { requestId: buffered.requestId, request: buffered.request };
        setAnswers({});
        setQuestionPrompt({ requestId: buffered.requestId, request: buffered.request.params.request });
      }
    },
    [shelveActivePrompts],
  );

  return {
    approvalPrompt,
    questionPrompt,
    answers,
    setAnswers,
    handleServerRequest,
    handleNotification,
    resolveApproval,
    resolveQuestion,
    activateThread,
  };
}
