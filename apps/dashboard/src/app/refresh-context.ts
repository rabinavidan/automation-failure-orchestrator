import { createContext, useContext } from 'react';
import type { View } from './routes';

export const REFRESH_INTERVAL_MS = 15_000;

/**
 * What the shell shares with the views: a refresh tick (the 15-second interval and the Refresh
 * button), a place to report failures for the degraded banner, and the nav badge counts. Each
 * view fetches only its own endpoints, and only while it is shown.
 */
export interface RefreshApi {
  tick: number;
  pending: number;
  error?: string;
  lastRefresh?: Date;
  counts: Partial<Record<View, number>>;
  refresh(): void;
  track<T>(work: Promise<T>): Promise<T>;
  reportError(error: unknown, fallback: string): void;
  reportSuccess(): void;
  setCount(view: View, count: number): void;
}

export const RefreshContext = createContext<RefreshApi | null>(null);

export function useRefresh(): RefreshApi {
  const api = useContext(RefreshContext);
  if (!api) throw new Error('useRefresh must be used inside RefreshProvider');
  return api;
}
