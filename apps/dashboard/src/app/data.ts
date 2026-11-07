import { useCallback, useEffect, useRef, useState } from 'react';
import { useRefresh } from './refresh-context';

/** GET a JSON endpoint; a non-2xx answer is an outage for the degraded banner. */
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('One or more services are unavailable');
  return (await response.json()) as T;
}

/**
 * Loads a view's data on mount and on every refresh tick. A failed refresh keeps the previous
 * data on screen and raises the degraded banner; `settled` turns true after the first attempt,
 * successful or not, so a view never stays on its loading skeleton.
 */
export function useViewData<T>(load: (signal: AbortSignal) => Promise<T>): {
  data: T | undefined;
  settled: boolean;
  reload(): Promise<void>;
} {
  const { tick, track, reportError, reportSuccess } = useRefresh();
  const [data, setData] = useState<T>();
  const [settled, setSettled] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    try {
      const result = await track(load(current.signal));
      if (current.signal.aborted) return;
      setData(result);
      reportSuccess();
    } catch (cause) {
      if (current.signal.aborted) return;
      reportError(cause, 'Unable to load dashboard data');
    } finally {
      if (!current.signal.aborted) setSettled(true);
    }
  }, [load, track, reportError, reportSuccess]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload, tick]);

  useEffect(() => () => controller.current?.abort(), []);

  return { data, settled, reload };
}
