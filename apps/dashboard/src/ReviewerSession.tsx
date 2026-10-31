import { useState } from 'react';
import type { ReviewerSession } from './useReviewerSession';

export function ReviewerSignIn({ session }: { session: ReviewerSession }) {
  const [draft, setDraft] = useState('');
  if (session.status === 'signed_in' && session.identity) {
    return (
      <div className="flex items-center gap-3 text-xs">
        <span>
          Signed in as <strong className="font-mono">{session.identity.name}</strong>{' '}
          <span className="text-slate-500">({session.identity.roles.join(', ')})</span>
        </span>
        <button
          type="button"
          onClick={session.signOut}
          className="border border-slate-300 px-2 py-1 font-bold uppercase"
        >
          Sign out
        </button>
      </div>
    );
  }
  return (
    <form
      className="flex items-center gap-2 text-xs font-bold"
      onSubmit={(event) => {
        event.preventDefault();
        session.signIn(draft);
        setDraft('');
      }}
    >
      <label className="flex items-center gap-2">
        Reviewer token
        <input
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="w-48 border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-ink"
        />
      </label>
      <button type="submit" className="border border-ink bg-ink px-3 py-2 uppercase text-white">
        Sign in
      </button>
      {session.status === 'checking' && <span role="status">Checking…</span>}
      {session.status === 'invalid' && (
        <span role="alert" className="text-red-700">
          Token not recognized
        </span>
      )}
    </form>
  );
}
