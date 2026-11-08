import type { FailureRow as Failure } from '@orchestrator/shared-types';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BrainCircuit, Network } from 'lucide-react';
import { BackendBadge } from '../../app/RuntimeModes';
import type { AgentExecution } from '../../types';
import { Badge } from '../../ui/primitives';
import { formatTime, humanize } from '../../ui/format';

/** The side panel for one failure: history, the agent investigation and its graph timeline. */
export function FailureDossier({ failure, onClose }: { failure: Failure; onClose: () => void }) {
  const [audit, setAudit] = useState<{ fingerprint: string; executions: AgentExecution[] }>();
  const auditLoading = audit?.fingerprint !== failure.fingerprint;
  const agentExecutions = auditLoading ? [] : audit.executions;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/ingestion/api/failures/${failure.fingerprint}/agent-executions`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load agent audit');
        return response.json() as Promise<{ executions?: AgentExecution[] }>;
      })
      .then((payload) =>
        setAudit({ fingerprint: failure.fingerprint, executions: payload.executions ?? [] })
      )
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
        setAudit({ fingerprint: failure.fingerprint, executions: [] });
      });
    return () => controller.abort();
  }, [failure.fingerprint]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end bg-ink/45 backdrop-blur-sm"
      onClick={() => onClose()}
      role="presentation"
    >
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl scrollbar-thin"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Failure dossier for ${failure.title}`}
      >
        <button
          onClick={() => onClose()}
          className="float-right border border-ink px-3 py-1.5 text-xs font-bold"
        >
          Close
        </button>
        <p className="font-mono text-[10px] uppercase tracking-widest text-slate-600">
          Failure dossier
        </p>
        <h2 className="mt-4 pr-20 text-2xl font-extrabold tracking-tight">{failure.title}</h2>
        <div className="mt-4">
          <Badge value={failure.classification} />
        </div>
        <dl className="mt-7 grid grid-cols-2 gap-px bg-slate-200 border border-slate-200">
          {[
            ['Fingerprint', failure.fingerprint.slice(0, 16)],
            ['Run count', String(failure.run_count)],
            ['Failures', String(failure.fail_count)],
            ['Passes', String(failure.pass_count)],
            ['Jira', failure.jira_issue_key ?? 'Not linked'],
            ['Last seen', formatTime(failure.last_seen_at)],
          ].map(([label, value]) => (
            <div key={label} className="bg-white p-4">
              <dt className="font-mono text-[9px] uppercase text-slate-600">{label}</dt>
              <dd className="mt-1 truncate text-xs font-bold">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-7">
          <h3 className="text-xs font-bold uppercase tracking-wide">Recent state transitions</h3>
          <div className="mt-3 flex gap-2">
            {failure.last_statuses?.map((status, index) => (
              <span
                key={`${status}-${index}`}
                title={status}
                className={`h-3 flex-1 ${status === 'passed' ? 'bg-emerald-500' : status === 'failed' ? 'bg-coral' : 'bg-slate-300'}`}
              />
            ))}
          </div>
        </div>
        {failure.agent_investigation ? (
          <div className="mt-8 border-t border-ink pt-6">
            <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
              <BrainCircuit size={14} /> Agent investigation
            </p>
            {!auditLoading && agentExecutions[0]?.model_backend !== 'real' && (
              <p
                role="note"
                className="mt-3 border-l-4 border-amber-400 bg-amber-50 p-3 text-xs text-amber-900"
              >
                {agentExecutions[0]?.model_backend === 'stub'
                  ? 'Produced by the deterministic demo stub, not a language model. Not real-model evidence.'
                  : agentExecutions[0]?.model_backend
                    ? `Model backend was "${agentExecutions[0].model_backend}"; treat this output as unverified.`
                    : 'Model backend not recorded for this investigation; treat it as unverified.'}
              </p>
            )}
            <h3 className="mt-4 text-xl font-extrabold">
              {failure.agent_investigation.suspectedRootCause}
            </h3>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              {failure.agent_investigation.explanation}
            </p>
            <div className="mt-5 bg-ink p-5 text-white">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold">Confidence</span>
                <span className="font-mono text-xl text-signal">
                  {Math.round(failure.agent_investigation.confidence * 100)}%
                </span>
              </div>
              <div className="mt-3 h-1.5 bg-white/15">
                <div
                  className="h-full bg-signal"
                  style={{ width: `${failure.agent_investigation.confidence * 100}%` }}
                />
              </div>
            </div>
            {failure.agent_investigation.specialistReports &&
              failure.agent_investigation.specialistReports.length > 0 && (
                <div className="mt-5">
                  <p className="font-mono text-[9px] uppercase tracking-widest text-slate-600">
                    Supervisor team reports
                  </p>
                  <div className="mt-3 grid gap-3">
                    {failure.agent_investigation.specialistReports.map((report) => (
                      <div
                        key={report.agent}
                        className="border-l-4 border-violet-400 bg-violet-50 p-4"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-bold uppercase">
                            {report.agent} specialist
                          </span>
                          <span className="font-mono text-[10px] text-violet-700">
                            {Math.round(report.confidence * 100)}%
                          </span>
                        </div>
                        <p className="mt-2 text-xs leading-5 text-slate-600">{report.summary}</p>
                        {report.risk && (
                          <span className="mt-2 inline-block border border-violet-300 px-2 py-0.5 font-mono text-[9px] uppercase">
                            risk: {report.risk}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            {failure.agent_investigation.sources &&
              failure.agent_investigation.sources.length > 0 && (
                <div className="mt-5">
                  <p className="font-mono text-[9px] uppercase tracking-widest text-slate-600">
                    Retrieved sources
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {failure.agent_investigation.sources.map((source) => (
                      <span
                        key={`${source.path}-${source.chunk}`}
                        className="border border-cyan/50 bg-cyan/10 px-2 py-1 font-mono text-[9px] text-cyan-900"
                      >
                        {source.path}#{source.chunk} · {Math.round(source.score * 100)}%
                      </span>
                    ))}
                  </div>
                </div>
              )}
          </div>
        ) : (
          <div className="mt-8 border border-dashed border-slate-300 p-5 text-sm text-slate-600">
            No persisted agent investigation for this historical signal. Run a new scenario with AI
            enabled.
          </div>
        )}
        <div className="mt-8 border-t border-ink pt-6">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
              <Network size={14} /> LangGraph execution timeline
            </p>
            {agentExecutions[0] && (
              <span
                className={`border px-2 py-1 font-mono text-[9px] uppercase ${
                  agentExecutions[0].status === 'completed' &&
                  agentExecutions[0].model_backend === 'real'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : agentExecutions[0].status === 'failed'
                      ? 'border-red-300 bg-red-50 text-red-800'
                      : 'border-amber-400 bg-amber-50 text-amber-900'
                }`}
              >
                {agentExecutions[0].status}
                {agentExecutions[0].status === 'completed' &&
                  agentExecutions[0].model_backend !== 'real' &&
                  ' · not real-model evidence'}
              </span>
            )}
          </div>
          {auditLoading ? (
            <div className="mt-4 h-24 animate-pulse bg-slate-100" />
          ) : agentExecutions.length > 0 ? (
            <div className="mt-5">
              <div className="mb-4 flex items-center justify-between text-[10px] text-slate-600">
                <span className="flex items-center gap-2 font-mono">
                  {agentExecutions[0].model}
                  <BackendBadge backend={agentExecutions[0].model_backend} />
                </span>
                <span>{formatTime(agentExecutions[0].started_at)}</span>
              </div>
              <p className="mb-4 font-mono text-[10px] text-slate-600">
                {agentExecutions[0].graph_version ?? 'graph unknown'} ·{' '}
                {agentExecutions[0].model_calls ?? 0} model calls ·{' '}
                {Number(agentExecutions[0].prompt_tokens ?? 0) +
                  Number(agentExecutions[0].completion_tokens ?? 0)}{' '}
                tokens · {agentExecutions[0].model_ms ?? 0} ms model time · local compute (not
                billed, not free)
              </p>
              <ol className="relative border-l border-slate-300 pl-5">
                {agentExecutions[0].events.map((event) => (
                  <li key={event.id} className="relative pb-5 last:pb-0">
                    <span className="absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-cyan shadow-sm" />
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-xs font-bold">{humanize(event.node)}</span>
                      <span className="font-mono text-[9px] uppercase text-slate-600">
                        {event.status}
                      </span>
                    </div>
                    {Object.keys(event.details).length > 0 && (
                      <p className="mt-1 break-words font-mono text-[9px] leading-4 text-slate-600">
                        {JSON.stringify(event.details)}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-600">
              No checkpoint-backed execution is available for this historical signal yet.
            </p>
          )}
        </div>
      </aside>
    </div>,
    document.body
  );
}
