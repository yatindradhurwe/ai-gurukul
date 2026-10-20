import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/**
 * Fetch on mount / when `path` changes; `reload()` re-fetches. Moving to a new
 * path clears the previous page's data, and a slow response for an old path
 * never overwrites a newer one.
 */
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const shown = useRef<string | null>(null);

  const reload = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    if (shown.current !== path) {
      shown.current = path;
      setData(null);
      setError(null);
    }
    setLoading(true);
    try {
      const body = await api<T>(path);
      if (mine !== seq.current) return;
      setData(body);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (!path) {
      seq.current++;
      shown.current = null;
      setData(null);
      setLoading(false);
      return;
    }
    reload();
  }, [path, reload]);

  return { data, error, loading, reload, setData };
}
