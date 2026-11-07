import { useEffect } from 'react';
import { CircleDot } from 'lucide-react';
import { getJson, useViewData } from '../../app/data';
import { useRefresh } from '../../app/refresh-context';
import type { JiraIssue } from '../../types';
import { EmptyState, LoadingState } from '../../ui/primitives';
import { formatTime } from '../../ui/format';

async function loadIssues(signal: AbortSignal): Promise<JiraIssue[]> {
  const payload = await getJson<{ issues?: JiraIssue[] }>('/api/mock/jira/issues', signal);
  return payload.issues ?? [];
}

/** Issues the CI policy created or commented on (the mock Jira in local and demo stacks). */
export function JiraActivity() {
  const { data, settled } = useViewData(loadIssues);
  const { setCount } = useRefresh();
  useEffect(() => {
    if (data) setCount('jira', data.length);
  }, [data, setCount]);

  if (!settled) return <LoadingState />;
  const issues = data ?? [];

  return (
    <section className="page-enter py-7">
      {issues.length === 0 ? (
        <EmptyState label="Jira issues" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {issues.map((issue) => (
            <article
              key={issue.key}
              data-testid="jira-issue"
              data-issue-key={issue.key}
              className="border border-ink/10 bg-white p-5 shadow-panel"
            >
              <div className="flex items-center justify-between gap-4">
                <span className="bg-[#1257c4] px-2.5 py-1 font-mono text-xs font-bold text-white">
                  {issue.key}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-slate-600">
                  <CircleDot size={13} />
                  {issue.fields.status?.name ?? 'Open'}
                </span>
              </div>
              <h2 className="mt-4 text-lg font-extrabold">{issue.fields.summary}</h2>
              <p className="mt-3 line-clamp-4 whitespace-pre-line text-xs leading-5 text-slate-600">
                {issue.fields.description ?? 'No description'}
              </p>
              <div className="mt-5 flex flex-wrap gap-1.5">
                {issue.fields.labels?.map((label) => (
                  <span
                    key={label}
                    className="bg-slate-100 px-2 py-1 font-mono text-[9px] text-slate-600"
                  >
                    {label}
                  </span>
                ))}
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-slate-200 pt-4 text-xs text-slate-600">
                <span>{issue.comments?.length ?? 0} comments</span>
                <span>{formatTime(issue.created)}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
