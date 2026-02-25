import { useCallback, useEffect, useState } from "react";
import type { SessionEntry } from "../lib/types.js";

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
      setEntries(data.entries);
    } catch (err) {
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
