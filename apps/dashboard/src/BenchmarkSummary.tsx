import { useEffect, useState } from 'react';

type TrackMetric = { n: number; accuracy: number | null; macroF1: number | null };
type AgentMetrics = {
  applicable: number;
  failureRate: number | null;
  actionPolicyCompliance: number | null;
  unsupportedClaimRate: number | null;
  safetyViolations: number;
};
type Report = {
  id: string;
  reportPath: string;
  meta: {
    commit: string;
    dataset: string;
    datasetCases: number;
    humanValidatedLabels: boolean;
    configs: string[];
    repetitions: number;
    model: string | null;
    modelBackend: string;
    generatedAt: string;
  };
  summaries: Array<{
    config: string;
    decision: { byTrack: Record<string, TrackMetric> };
    agent: AgentMetrics | null;
  }>;
};

const REPO = 'https://github.com/rabinavidan/automation-failure-orchestrator/blob/main/';
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;

/** Benchmark results exactly as stored in committed summary.json files; nothing hardcoded. */
export function BenchmarkSummary() {
  const [reports, setReports] = useState<Report[]>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ingestion/api/benchmark/summary')
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<{ reports: Report[] }>;
      })
      .then((body) => !cancelled && setReports(body.reports))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-label="Benchmark" className="border border-ink/10 bg-white p-5 shadow-panel">
      <h2 className="font-bold">Investigation benchmark</h2>
      {failed && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          Benchmark summary unavailable.
        </p>
      )}
      {!failed && !reports && <div className="mt-3 h-16 animate-pulse bg-slate-100" />}
      {reports && reports.length === 0 && (
        <p className="mt-2 text-xs text-slate-500">No benchmark report has been committed yet.</p>
      )}
      {reports?.map((report) => {
        const det = report.summaries[0]?.decision.byTrack ?? {};
        const agents = report.summaries.filter((s) => s.agent);
        return (
          <div key={report.id} className="mt-3 border-t border-slate-200 pt-3 text-xs">
            <p className="font-mono text-[10px] text-slate-500">
              {report.meta.dataset} · {report.meta.datasetCases} cases ·{' '}
              {report.meta.humanValidatedLabels ? 'human-validated labels' : 'synthetic labels'} ·
              commit {report.meta.commit.slice(0, 7)} ·{' '}
              {new Date(report.meta.generatedAt).toLocaleDateString()}
            </p>
            <p className="mt-1">
              Model:{' '}
              <strong>
                {report.meta.model
                  ? `${report.meta.model} (${report.meta.modelBackend})`
                  : 'none (deterministic only)'}
              </strong>
            </p>
            <table className="mt-2 w-full text-left">
              <caption className="sr-only">Deterministic decision quality by track</caption>
              <thead className="text-[10px] uppercase text-slate-500">
                <tr>
                  <th scope="col">Track</th>
                  <th scope="col">n</th>
                  <th scope="col">Accuracy</th>
                  <th scope="col">Macro-F1</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(det).map(([track, m]) => (
                  <tr key={track}>
                    <td className="font-mono uppercase">{track}</td>
                    <td>{m.n}</td>
                    <td>{pct(m.accuracy)}</td>
                    <td>{pct(m.macroF1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {agents.length === 0 ? (
              <p className="mt-2 text-slate-500">
                Agent configurations not run in this report: no real-model quality claim.
              </p>
            ) : (
              agents.map((s) => (
                <p key={s.config} className="mt-2">
                  <strong>{s.config}</strong>: {s.agent!.applicable} runs, failure rate{' '}
                  {pct(s.agent!.failureRate)}, action policy {pct(s.agent!.actionPolicyCompliance)},
                  unsupported claims {pct(s.agent!.unsupportedClaimRate)}, safety violations{' '}
                  {s.agent!.safetyViolations}
                </p>
              ))
            )}
            <a
              href={`${REPO}${report.reportPath}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block font-bold underline"
            >
              Full report
            </a>
          </div>
        );
      })}
    </section>
  );
}
