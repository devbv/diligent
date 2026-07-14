// @summary Hook for fetching and loading entries from a debug session
import { createLogger } from "@diligent/logging";
import { useCallback, useEffect, useState } from "react";
import type { SessionEntry } from "../lib/types.js";

const logger = createLogger({
  scope: "debug-viewer",
  context: { component: "client.useSession" },
});

export function useSession(sessionId: string | null) {
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSession = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      logger.debug("session_fetch_succeeded", {
        message: "Fetched session entries.",
        sessionId: id,
        fields: { entryCount: Array.isArray(data.entries) ? data.entries.length : undefined },
      });
      setEntries(data.entries);
    } catch (err) {
      logger.warn("session_fetch_failed", {
        message: "Failed to fetch session entries.",
        sessionId: id,
        error: err,
      });
      setError(err instanceof Error ? err.message : "Failed to fetch session");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionId) {
      fetchSession(sessionId);
    } else {
      setEntries([]);
    }
  }, [sessionId, fetchSession]);

  return { entries, setEntries, loading, error };
}
