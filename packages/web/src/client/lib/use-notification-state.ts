// @summary Desktop notification + attention-tracking hook
import { useCallback, useEffect, useRef, useState } from "react";
import { createDesktopNotificationController, readDesktopNotificationsEnabled } from "./desktop-notification";

export function useNotificationState() {
  const desktopNotificationsRef = useRef(createDesktopNotificationController());
  const [desktopNotificationsEnabled, setDesktopNotificationsEnabled] = useState(() =>
    readDesktopNotificationsEnabled(),
  );
  const [attentionThreadIds, setAttentionThreadIds] = useState<Set<string>>(new Set());

  const markAttention = useCallback((threadId: string) => {
    setAttentionThreadIds((prev) => {
      if (prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.add(threadId);
      return next;
    });
  }, []);

  const clearAttention = useCallback((threadId: string) => {
    setAttentionThreadIds((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.delete(threadId);
      return next;
    });
  }, []);

  useEffect(() => {
    desktopNotificationsRef.current.setEnabled(desktopNotificationsEnabled);
  }, [desktopNotificationsEnabled]);

  return {
    attentionThreadIds,
    markAttention,
    clearAttention,
    desktopNotificationsRef,
    desktopNotificationsEnabled,
    setDesktopNotificationsEnabled,
  };
}
