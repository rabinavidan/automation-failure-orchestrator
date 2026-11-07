import type { FailureRow as Failure } from '@orchestrator/shared-types';
import { useEffect } from 'react';
import { History, ToolCase } from 'lucide-react';
import { getJson, useViewData } from '../../app/data';
import { useRefresh } from '../../app/refresh-context';
import { Badge, EmptyState, LoadingState } from '../../ui/primitives';

async function loadInvestigations(signal: AbortSignal): Promise<Failure[]> {
  const payload = await getJson<{ failures?: Failure[] }>(
    '/api/ingestion/api/failures?limit=100',
    signal
  );
  return (payload.failures ?? []).filter((failure) => failure.agent_investigation);
}

/** Persisted agent investigations, one card per failure fingerprint. */
export function Investigations() {
  const { data, settled } = useViewData(loadInvestigations);
  const { setCount } = useRefresh();
  useEffect(() => {
    if (data) setCount('investigations', data.length);
  }, [data, setCount]);

  if (!settled) return <LoadingState />;
  const investigations = data ?? [];

  return (
    <section className="page-enter grid gap-5 py-7 xl:grid-cols-2">
      {investigations.length === 0 ? (
        <div className="xl:col-span-2">
          <EmptyState label="persisted AI investigations" />
        </div>
      ) : (
        investigations.map((failure) => {
          const agent = failure.agent_investigation!;
          return (
            <article
              key={failure.fingerprint}
              className="border border-ink/10 bg-white p-5 shadow-panel"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Badge value={failure.classification} />
                  <h2 className="mt-3 text-lg font-extrabold tracking-tight">{failure.title}</h2>
                </div>
                <div className="grid h-14 w-14 shrink-0 place-items-center bg-signal font-mono text-sm font-bold">
                  {Math.round(agent.confidence * 100)}%
                </div>
              </div>
              <div className="mt-5 border-l-4 border-signal bg-lime-50 p-4">
                <p className="font-mono text-[9px] font-semibold uppercase tracking-widest text-slate-600">
                  Suspected root cause
                </p>
                <p className="mt-2 text-sm font-bold">{agent.suspectedRootCause}</p>
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-600">{agent.explanation}</p>
              {agent.specialistReports && agent.specialistReports.length > 0 && (
                <div className="mt-5 grid gap-2 sm:grid-cols-3">
                  {agent.specialistReports.map((report) => (
                    <div
                      key={report.agent}
                      className="border border-violet-200 bg-violet-50/60 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[9px] font-bold uppercase text-violet-800">
                          {report.agent} agent
                        </span>
                        <span className="font-mono text-[9px] text-violet-600">
                          {Math.round(report.confidence * 100)}%
                        </span>
                      </div>
                      <p className="mt-2 text-[11px] leading-4 text-slate-600">{report.summary}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-5">
                <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide">
                  <History size={14} /> Evidence
                </p>
                <ul className="mt-3 space-y-2">
                  {agent.evidence.map((item, index) => (
                    <li key={index} className="flex gap-3 text-xs leading-5 text-slate-600">
                      <span className="font-mono font-bold text-ink">0{index + 1}</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
                <span className="bg-ink px-2.5 py-1 font-mono text-[10px] text-white">
                  {agent.recommendedAction}
                </span>
                {agent.toolsUsed.map((tool) => (
                  <span
                    key={tool}
                    className="flex items-center gap-1 border border-slate-300 px-2 py-1 font-mono text-[9px]"
                  >
                    <ToolCase size={11} />
                    {tool}
                  </span>
                ))}
                <span className="ml-auto font-mono text-[9px] text-slate-600">{agent.model}</span>
              </div>
              {agent.sources && agent.sources.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {agent.sources.map((source) => (
                    <span
                      key={`${source.path}-${source.chunk}`}
                      className="border border-cyan/50 bg-cyan/10 px-2 py-1 font-mono text-[9px] text-cyan-900"
                    >
                      {source.path}#{source.chunk} · {Math.round(source.score * 100)}%
                    </span>
                  ))}
                </div>
              )}
            </article>
          );
        })
      )}
    </section>
  );
}
