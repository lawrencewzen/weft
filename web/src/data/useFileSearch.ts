import { useEffect, useRef, useState } from 'react';
import { searchWorkspaceFiles, type FileSearchHit } from './api';

export type UseFileSearchOptions = {
  limit?: number;
  debounceMs?: number;
};

export type UseFileSearchResult = {
  entries: FileSearchHit[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
};

export function useFileSearch(
  workspaceId: string | null,
  query: string,
  options?: UseFileSearchOptions,
): UseFileSearchResult {
  const limit = options?.limit ?? 50;
  const debounceMs = options?.debounceMs ?? 150;

  const [entries, setEntries] = useState<FileSearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);

  const trimmed = query.trim();

  useEffect(() => {
    // Clear any pending debounce timer
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Abort previous in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    if (!workspaceId || !trimmed) {
      setEntries([]);
      setTruncated(false);
      setLoading(false);
      setError(null);
      return;
    }

    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);

    timerRef.current = window.setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await searchWorkspaceFiles(workspaceId, trimmed, limit, controller.signal);
        if (seq === seqRef.current && !controller.signal.aborted) {
          setEntries(res.entries);
          setTruncated(res.truncated);
          setLoading(false);
          setError(null);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted || seq !== seqRef.current) {
          return;
        }
        setEntries([]);
        setTruncated(false);
        setLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    }, debounceMs);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [workspaceId, trimmed, limit, debounceMs]);

  return {
    entries,
    truncated,
    loading,
    error,
  };
}
