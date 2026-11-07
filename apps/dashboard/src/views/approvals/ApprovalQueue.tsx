import { useState } from 'react';
import { useViewData } from '../../app/data';
import { useRefresh } from '../../app/refresh-context';
import { loadPendingApprovals } from './api';
import { ReviewerSignIn } from '../../app/ReviewerSession';
import type { ReviewerSession } from '../../app/useReviewerSession';
import { Badge, EmptyState, LoadingState } from '../../ui/primitives';

/** Investigations paused for a human decision; approving resumes the persisted graph thread. */
export function ApprovalQueue({ session }: { session: ReviewerSession }) {
  const { data, settled, reload } = useViewData(loadPendingApprovals);
  const { refresh, reportError } = useRefresh();
  const [decidingThread, setDecidingThread] = useState<string>();

  const decideApproval = async (threadId: string, decision: 'approved' | 'rejected') => {
    setDecidingThread(threadId);
    try {
      const response = await fetch(
        `/api/ingestion/api/approvals/${encodeURIComponent(threadId)}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...session.authHeader },
          body: JSON.stringify({ decision }),
        }
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Approval decision failed (HTTP ${response.status})`);
      }
      await reload();
      refresh();
    } catch (decisionError) {
      reportError(decisionError, 'Approval decision failed');
    } finally {
      setDecidingThread(undefined);
    }
  };

  if (!settled) return <LoadingState />;
  const approvals = data ?? [];

  return (
    <section className="page-enter py-7">
      <div className="mb-6 flex flex-col gap-3 border border-ink/10 bg-white p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-bold">Human control plane</h2>
          <p className="mt-1 text-xs text-slate-600">
            Decisions resume the exact persisted LangGraph thread.
          </p>
        </div>
        <ReviewerSignIn session={session} />
      </div>
      {approvals.length === 0 ? (
        <EmptyState label="pending approvals" />
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {approvals.map((approval) => (
            <article
              key={approval.thread_id}
              data-testid="approval-card"
              data-thread-id={approval.thread_id}
              className="border border-ink/10 bg-white p-5 shadow-panel"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Badge value={approval.classification} />
                  <h2 className="mt-3 text-lg font-extrabold">{approval.test_id}</h2>
                </div>
                <span className="bg-amber-100 px-2.5 py-1 font-mono text-[9px] uppercase text-amber-800">
                  awaiting human
                </span>
              </div>
              <div className="mt-5 border-l-4 border-amber-400 bg-amber-50 p-4">
                <p className="font-mono text-[9px] uppercase text-slate-600">
                  Agent recommendation
                </p>
                <p className="mt-2 text-sm font-bold">
                  {approval.investigation.suspectedRootCause}
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-600">
                  {approval.investigation.explanation}
                </p>
              </div>
              <div className="mt-4 flex items-center justify-between font-mono text-[9px] text-slate-600">
                <span>{approval.requested_action}</span>
                <span>{Math.round(approval.investigation.confidence * 100)}% confidence</span>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 border-t border-slate-200 pt-5">
                <button
                  onClick={() => void decideApproval(approval.thread_id, 'rejected')}
                  disabled={!session.can('ci_reviewer') || decidingThread === approval.thread_id}
                  className="border border-ink px-4 py-2.5 text-xs font-bold disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  onClick={() => void decideApproval(approval.thread_id, 'approved')}
                  disabled={!session.can('ci_reviewer') || decidingThread === approval.thread_id}
                  className="bg-ink px-4 py-2.5 text-xs font-bold text-signal disabled:opacity-50"
                >
                  Approve &amp; resume
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
