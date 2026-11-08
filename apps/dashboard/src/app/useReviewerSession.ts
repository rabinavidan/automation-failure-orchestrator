import { useCallback, useEffect, useState } from 'react';

export type ReviewerIdentity = { name: string; roles: string[] };

export type ReviewerSession = {
  identity?: ReviewerIdentity;
  status: 'signed_out' | 'checking' | 'signed_in' | 'invalid';
  authHeader: Record<string, string>;
  signIn: (token: string) => void;
  signOut: () => void;
  can: (role: 'ci_reviewer' | 'soc_responder' | 'admin') => boolean;
};

const STORAGE_KEY = 'signalops.reviewerToken';

function readToken(): string {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(STORAGE_KEY, token);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode); the session lasts for this page only.
  }
}

/**
 * Reviewer sign-in backed by the server: identity and roles come from GET /api/auth/whoami for
 * the presented token. The UI only hides controls; the API enforces roles on every decision.
 */
export function useReviewerSession(): ReviewerSession {
  const [token, setToken] = useState(readToken);
  const [identity, setIdentity] = useState<ReviewerIdentity>();
  const [status, setStatus] = useState<ReviewerSession['status']>(
    token ? 'checking' : 'signed_out'
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch('/api/ingestion/api/auth/whoami', { headers: { authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setIdentity(undefined);
          setStatus('invalid');
          return;
        }
        setIdentity((await response.json()) as ReviewerIdentity);
        setStatus('signed_in');
      })
      .catch(() => {
        if (!cancelled) setStatus('invalid');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const signIn = useCallback((next: string) => {
    const trimmed = next.trim();
    writeToken(trimmed);
    setStatus(trimmed ? 'checking' : 'signed_out');
    setToken(trimmed);
  }, []);
  const signOut = useCallback(() => {
    writeToken('');
    setToken('');
    setIdentity(undefined);
    setStatus('signed_out');
  }, []);

  return {
    identity,
    status,
    authHeader: token ? { authorization: `Bearer ${token}` } : {},
    signIn,
    signOut,
    can: (role) => Boolean(identity?.roles.includes(role) || identity?.roles.includes('admin')),
  };
}
