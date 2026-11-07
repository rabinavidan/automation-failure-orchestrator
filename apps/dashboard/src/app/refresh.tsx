import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { REFRESH_INTERVAL_MS, RefreshContext } from './refresh-context';
import type { View } from './routes';

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string>();
  const [lastRefresh, setLastRefresh] = useState<Date>();
  const [counts, setCounts] = useState<Partial<Record<View, number>>>({});

  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const track = useCallback(async <T,>(work: Promise<T>): Promise<T> => {
    setPending((value) => value + 1);
    try {
      return await work;
    } finally {
      setPending((value) => value - 1);
    }
  }, []);
  const reportError = useCallback((cause: unknown, fallback: string) => {
    setError(cause instanceof Error ? cause.message : fallback);
  }, []);
  const reportSuccess = useCallback(() => {
    setError(undefined);
    setLastRefresh(new Date());
  }, []);
  const setCount = useCallback((view: View, count: number) => {
    setCounts((current) => (current[view] === count ? current : { ...current, [view]: count }));
  }, []);

  const value = useMemo(
    () => ({
      tick,
      pending,
      error,
      lastRefresh,
      counts,
      refresh,
      track,
      reportError,
      reportSuccess,
      setCount,
    }),
    [
      tick,
      pending,
      error,
      lastRefresh,
      counts,
      refresh,
      track,
      reportError,
      reportSuccess,
      setCount,
    ]
  );
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}
