import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Crosshair,
  Gauge,
  Lock,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Timer,
  X,
} from 'lucide-react';

type Disposition =
  'false_positive' | 'duplicate' | 'true_positive' | 'benign_true_positive' | 'needs_investigation';

type AlertRow = {
  alert_id: string;
  vendor: string;
  title: string;
  severity: string;
  status: string;
  host: string | null;
  user_name: string | null;
  enrichment_verdict: string | null;
  triage_disposition: Disposition | null;
  triage_priority: string | null;
  risk_score: number | null;
  ai_investigation_status: string | null;
  received_at: string;
};

type ResponseAction = {
  id: string;
  alert_id: string;
  playbook_id: string;
  step_id: string;
  action: string;
  description: string;
  target_value: string;
  status: string;
  detail: string | null;
  reviewer: string | null;
  alert_title?: string;
  triage_priority?: string;
};

type AlertDetail = AlertRow & {
  triage: {
    reasons: string[];
    recommendedAction: string;
    matchedPolicyId?: string;
    mitre: { tactics: string[]; techniques: string[]; inferred: boolean };
  } | null;
  enrichment: {
    summary: { verdict: string; malicious: number; skipped: number };
    enrichments: Array<{
      normalizedValue: string;
      verdict: string;
      skippedReason?: string | null;
      indicator: { type: string };
    }>;
  } | null;
  ai_investigation: {
    summary: string;
    recommendedResponse: string;
    responseSteps: string[];
    citedRunbooks: string[];
    requiresHumanApproval: boolean;
    conflictsWithTriage: boolean;
    confidence: number;
  } | null;
  ai_evaluation: { passed: boolean; failures: string[] } | null;
};

type Metrics = {
  windowHours: number;
  alerts: {
    total: number;
    true_positives: number;
    analyst_queue: number;
    automationRate: number;
    median_triage_ms: number;
    p95_triage_ms: number;
  };
  byDisposition: Array<{ disposition: string; count: number }>;
  topTechniques: Array<{ technique: string; count: number }>;
  response: {
    pending_approval: number;
    contained: number;
    blocked_by_guard: number;
    rolled_back: number;
    median_approval_ms: number;
  };
};

const API = '/api/ingestion/api';

const dispositionStyle: Record<string, string> = {
  true_positive: 'bg-coral/15 text-[#a82e1b] border-coral/40',
  needs_investigation: 'bg-amber-100 text-amber-800 border-amber-300',
  false_positive: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  benign_true_positive: 'bg-cyan/20 text-cyan-900 border-cyan/60',
  duplicate: 'bg-slate-100 text-slate-600 border-slate-300',
};

const dispositionColor: Record<string, string> = {
  true_positive: '#ff735c',
  needs_investigation: '#f59e0b',
  false_positive: '#10b981',
  benign_true_positive: '#22b8c2',
  duplicate: '#94a3b8',
  untriaged: '#cbd5e1',
};

const REVERSIBLE = new Set(['firewall.block_ip', 'edr.isolate_host']);

function label(value?: string | null) {
  return (value ?? '—').replaceAll('_', ' ');
}

function duration(ms?: number) {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function Pill({ value, style }: { value?: string | null; style?: string }) {
  return (
    <span
      className={`inline-flex border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${style ?? dispositionStyle[value ?? ''] ?? 'border-slate-300 bg-slate-100 text-slate-700'}`}
    >
      {label(value)}
    </span>
  );
}

function Kpi({
  title,
  value,
  note,
  icon: Icon,
}: {
  title: string;
  value: string | number;
  note: string;
  icon: typeof Gauge;
}) {
  return (
    <article className="border border-ink/10 bg-white p-5 shadow-panel">
      <div className="flex items-start justify-between">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">{title}</p>
        <Icon size={18} className="text-slate-500" />
      </div>
      <p className="mt-4 text-3xl font-extrabold tracking-[-0.04em] text-ink">{value}</p>
      <p className="mt-2 text-xs text-slate-500">{note}</p>
    </article>
  );
}

const PRIORITY_RANK: Record<string, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

/** Most urgent work first: priority, then risk, then most recent. */
function sortForAnalysts(rows: AlertRow[]): AlertRow[] {
  return [...rows].sort(
    (a, b) =>
      (PRIORITY_RANK[a.triage_priority ?? ''] ?? 9) -
        (PRIORITY_RANK[b.triage_priority ?? ''] ?? 9) ||
      (b.risk_score ?? -1) - (a.risk_score ?? -1) ||
      b.received_at.localeCompare(a.received_at)
  );
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API}${path}`, { signal });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/**
 * SOC console: alert queue, deterministic triage + AI evidence, and the human
 * approval gate for containment (approve / reject / roll back).
 */
export function SocConsole({ reviewer }: { reviewer: string }) {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [pending, setPending] = useState<ResponseAction[]>([]);
  const [executed, setExecuted] = useState<ResponseAction[]>([]);
  const [metrics, setMetrics] = useState<Metrics>();
  const [error, setError] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [selected, setSelected] = useState<AlertDetail>();
  const [selectedActions, setSelectedActions] = useState<ResponseAction[]>([]);
  const [dispositionFilter, setDispositionFilter] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const filter = dispositionFilter ? `&disposition=${dispositionFilter}` : '';
      const [alertList, pendingList, succeededList, metricData] = await Promise.all([
        getJson<{ alerts: AlertRow[] }>(`/alerts?limit=50${filter}`),
        getJson<{ actions: ResponseAction[] }>('/responses/actions?status=pending_approval'),
        getJson<{ actions: ResponseAction[] }>('/responses/actions?status=succeeded'),
        getJson<Metrics>('/alerts/metrics?hours=24'),
      ]);
      setAlerts(sortForAnalysts(alertList.alerts));
      setPending(pendingList.actions);
      setExecuted(succeededList.actions.filter((a) => REVERSIBLE.has(a.action)));
      setMetrics(metricData);
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'SOC data unavailable');
    }
  }, [dispositionFilter]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 10_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [load]);

  const openAlert = async (alertId: string) => {
    try {
      const [{ alert }, { actions }] = await Promise.all([
        getJson<{ alert: AlertDetail }>(`/alerts/${encodeURIComponent(alertId)}`),
        getJson<{ actions: ResponseAction[] }>(
          `/responses/actions?alertId=${encodeURIComponent(alertId)}`
        ),
      ]);
      setSelected(alert);
      setSelectedActions(actions);
    } catch {
      setError('Could not load alert detail');
    }
  };

  const act = async (id: string, path: 'decision' | 'rollback', body: Record<string, string>) => {
    setBusyAction(id);
    try {
      const response = await fetch(`${API}/responses/actions/${id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewer, ...body }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      await load();
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : 'Action failed');
    } finally {
      setBusyAction(undefined);
    }
  };

  const totalDisposition = metrics?.byDisposition.reduce((sum, d) => sum + d.count, 0) ?? 0;

  return (
    <section className="page-enter space-y-6 py-7">
      {error && (
        <p className="border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-[#a82e1b]">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          title="Alerts (24h)"
          value={metrics?.alerts.total ?? 0}
          note={`${metrics?.alerts.true_positives ?? 0} true positives · ${metrics?.alerts.analyst_queue ?? 0} for analysts`}
          icon={ShieldAlert}
        />
        <Kpi
          title="Automation rate"
          value={`${Math.round((metrics?.alerts.automationRate ?? 0) * 100)}%`}
          note="Closed by deterministic triage with no analyst time"
          icon={Gauge}
        />
        <Kpi
          title="Time to triage"
          value={duration(metrics?.alerts.median_triage_ms)}
          note={`median · p95 ${duration(metrics?.alerts.p95_triage_ms)}`}
          icon={Timer}
        />
        <Kpi
          title="Containment"
          value={metrics?.response.pending_approval ?? 0}
          note={`awaiting approval · ${metrics?.response.contained ?? 0} executed · ${metrics?.response.blocked_by_guard ?? 0} guard-blocked`}
          icon={Lock}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <article className="border border-ink/10 bg-white p-5 shadow-panel">
          <h2 className="font-bold">Triage outcomes (24h)</h2>
          <div className="mt-4 flex h-3 w-full overflow-hidden bg-slate-100">
            {metrics?.byDisposition.map((d) => (
              <div
                key={d.disposition}
                title={`${label(d.disposition)}: ${d.count}`}
                style={{
                  width: `${totalDisposition ? (d.count / totalDisposition) * 100 : 0}%`,
                  background: dispositionColor[d.disposition] ?? '#cbd5e1',
                }}
              />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {metrics?.byDisposition.map((d) => (
              <span key={d.disposition} className="font-mono text-[10px] text-slate-600">
                <span
                  className="mr-1 inline-block h-2 w-2"
                  style={{ background: dispositionColor[d.disposition] ?? '#cbd5e1' }}
                />
                {label(d.disposition)} {d.count}
              </span>
            ))}
          </div>
        </article>
        <article className="border border-ink/10 bg-white p-5 shadow-panel">
          <h2 className="flex items-center gap-2 font-bold">
            <Crosshair size={16} /> Top ATT&amp;CK techniques
          </h2>
          <ul className="mt-3 space-y-1.5">
            {metrics?.topTechniques.length ? (
              metrics.topTechniques.map((t) => (
                <li key={t.technique} className="flex justify-between font-mono text-xs">
                  <a
                    className="underline decoration-dotted"
                    href={`https://attack.mitre.org/techniques/${t.technique.replace('.', '/')}/`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t.technique}
                  </a>
                  <span>{t.count}</span>
                </li>
              ))
            ) : (
              <li className="text-xs text-slate-500">No technique data yet.</li>
            )}
          </ul>
        </article>
      </div>

      <article className="border border-ink/10 bg-white p-5 shadow-panel">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-2 font-bold">
              <ShieldCheck size={16} /> Containment approval queue
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Playbooks never contain on their own. Guards are re-checked when you approve. Acting
              as <span className="font-mono">{reviewer || '—'}</span>.
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="flex items-center gap-2 border border-ink px-3 py-2 text-xs font-bold"
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
        {pending.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No containment awaiting approval.</p>
        ) : (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {pending.map((a) => (
              <div key={a.id} className="border-l-4 border-amber-400 bg-amber-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase text-slate-500">
                      #{a.id} · {a.playbook_id} · {a.triage_priority}
                    </p>
                    <p className="mt-1 text-sm font-bold">
                      {a.action} → <span className="font-mono">{a.target_value}</span>
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{a.description}</p>
                    <p className="mt-1 text-xs text-slate-500">{a.alert_title}</p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    disabled={!reviewer.trim() || busyAction === a.id}
                    onClick={() => void act(a.id, 'decision', { decision: 'rejected' })}
                    className="border border-ink px-3 py-2 text-xs font-bold disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    disabled={!reviewer.trim() || busyAction === a.id}
                    onClick={() => void act(a.id, 'decision', { decision: 'approved' })}
                    className="bg-ink px-3 py-2 text-xs font-bold text-signal disabled:opacity-50"
                  >
                    Approve &amp; execute
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {executed.length > 0 && (
          <div className="mt-5 border-t border-slate-200 pt-4">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Active containment (reversible)
            </p>
            <ul className="mt-2 divide-y divide-slate-100">
              {executed.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2 text-xs">
                  <span>
                    <span className="font-mono">#{a.id}</span> {a.detail}{' '}
                    <span className="text-slate-500">by {a.reviewer}</span>
                  </span>
                  <button
                    disabled={!reviewer.trim() || busyAction === a.id}
                    onClick={() =>
                      void act(a.id, 'rollback', { reason: 'Rolled back from SOC console' })
                    }
                    className="flex items-center gap-1 border border-ink px-2 py-1 font-bold disabled:opacity-50"
                  >
                    <RotateCcw size={12} /> Roll back
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </article>

      <article className="border border-ink/10 bg-white shadow-panel">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-bold">Alert queue</h2>
            <p className="mt-1 text-xs text-slate-500">
              Most urgent first: priority, risk, recency.
            </p>
          </div>
          <select
            value={dispositionFilter}
            onChange={(event) => setDispositionFilter(event.target.value)}
            className="border border-slate-300 px-3 py-2 font-mono text-xs"
            aria-label="Filter by disposition"
          >
            <option value="">All dispositions</option>
            {Object.keys(dispositionStyle).map((d) => (
              <option key={d} value={d}>
                {label(d)}
              </option>
            ))}
          </select>
        </div>
        {alerts.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">
            No alerts yet. Run <span className="font-mono">npm run demo:soc-triage</span>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 font-mono text-[10px] uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2">Priority</th>
                  <th className="px-4 py-2">Alert</th>
                  <th className="px-4 py-2">Entity</th>
                  <th className="px-4 py-2">Disposition</th>
                  <th className="px-4 py-2">Intel</th>
                  <th className="px-4 py-2">Risk</th>
                  <th className="px-4 py-2">AI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {alerts.map((a) => (
                  <tr
                    key={a.alert_id}
                    onClick={() => void openAlert(a.alert_id)}
                    className="cursor-pointer hover:bg-canvas"
                  >
                    <td className="px-4 py-2 font-mono font-bold">{a.triage_priority ?? '—'}</td>
                    <td className="px-4 py-2">
                      <p className="font-semibold">{a.title}</p>
                      <p className="font-mono text-[10px] text-slate-500">
                        {a.vendor} · {a.severity} · {a.status}
                      </p>
                    </td>
                    <td className="px-4 py-2 font-mono">
                      {a.host ?? '—'}
                      <br />
                      <span className="text-slate-500">{a.user_name ?? ''}</span>
                    </td>
                    <td className="px-4 py-2">
                      <Pill value={a.triage_disposition} />
                    </td>
                    <td className="px-4 py-2 font-mono">{a.enrichment_verdict ?? '—'}</td>
                    <td className="px-4 py-2 font-mono">{a.risk_score ?? '—'}</td>
                    <td className="px-4 py-2 font-mono text-slate-500">
                      {a.ai_investigation_status ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      {/* Portal: the section's enter animation uses a transform, which would make
          position: fixed relative to the section instead of the viewport. */}
      {selected &&
        createPortal(
          <aside
            role="dialog"
            aria-label="Alert detail"
            className="fixed inset-y-0 right-0 z-40 w-full max-w-xl overflow-y-auto border-l border-ink/10 bg-white p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Pill value={selected.triage_disposition} />
                <h2 className="mt-3 text-xl font-extrabold">{selected.title}</h2>
                <p className="mt-1 font-mono text-[10px] text-slate-500">{selected.alert_id}</p>
              </div>
              <button onClick={() => setSelected(undefined)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <h3 className="mt-6 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Deterministic triage · {selected.triage_priority} · risk {selected.risk_score}
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
              {selected.triage?.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p className="mt-2 font-mono text-[10px] text-slate-500">
              ATT&amp;CK {selected.triage?.mitre.techniques.join(', ') || '—'} (
              {selected.triage?.mitre.tactics.join(', ') || '—'})
              {selected.triage?.mitre.inferred ? ' · inferred from rule name' : ''}
            </p>

            <h3 className="mt-6 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Threat intel · {selected.enrichment?.summary.verdict ?? 'not enriched'}
            </h3>
            <ul className="mt-2 space-y-1 font-mono text-[11px]">
              {selected.enrichment?.enrichments.map((e) => (
                <li key={`${e.indicator.type}:${e.normalizedValue}`}>
                  {e.indicator.type} {e.normalizedValue} →{' '}
                  {e.skippedReason ? (
                    <span className="text-slate-500">{e.skippedReason}</span>
                  ) : (
                    e.verdict
                  )}
                </li>
              ))}
            </ul>

            <h3 className="mt-6 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Advisory AI investigation · {selected.ai_investigation_status ?? 'not run'}
            </h3>
            {selected.ai_investigation ? (
              <div className="mt-2 border-l-4 border-cyan bg-cyan/10 p-3 text-xs">
                <p className="font-bold">{selected.ai_investigation.summary}</p>
                <p className="mt-1">
                  Recommends <strong>{selected.ai_investigation.recommendedResponse}</strong> (
                  {Math.round(selected.ai_investigation.confidence * 100)}% confidence)
                  {selected.ai_investigation.requiresHumanApproval
                    ? ' · human approval required'
                    : ''}
                  {selected.ai_investigation.conflictsWithTriage ? ' · disagrees with triage' : ''}
                </p>
                <ol className="mt-2 list-decimal pl-5">
                  {selected.ai_investigation.responseSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <p className="mt-2 font-mono text-[10px]">
                  Runbooks: {selected.ai_investigation.citedRunbooks.join(', ')} · evaluation{' '}
                  {selected.ai_evaluation?.passed
                    ? 'passed'
                    : `failed: ${selected.ai_evaluation?.failures.join('; ')}`}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-500">
                Runs only for true positives and the analyst queue when AI is enabled.
              </p>
            )}

            <h3 className="mt-6 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Response actions
            </h3>
            <ul className="mt-2 divide-y divide-slate-100 text-xs">
              {selectedActions.length === 0 && (
                <li className="py-2 text-slate-500">No playbook matched.</li>
              )}
              {selectedActions.map((a) => (
                <li key={a.id} className="flex justify-between gap-3 py-2">
                  <span>
                    <span className="font-mono">#{a.id}</span> {a.action}{' '}
                    <span className="font-mono">{a.target_value}</span>
                    {a.detail ? <span className="text-slate-500"> · {a.detail}</span> : null}
                  </span>
                  <Pill value={a.status} style="border-slate-300 bg-slate-50 text-slate-700" />
                </li>
              ))}
            </ul>
          </aside>,
          document.body
        )}
    </section>
  );
}
