import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  BookOpen,
  BrainCircuit,
  Bug,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  GitBranch,
  History,
  LayoutDashboard,
  MessageSquare,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TicketCheck,
  ToolCase,
  XCircle,
  Zap,
} from 'lucide-react';

type View = 'overview' | 'observability' | 'approvals' | 'knowledge' | 'investigations' | 'jira' | 'slack';

type AgentInvestigation = {
  suspectedRootCause: string;
  evidence: string[];
  recommendedAction: string;
  confidence: number;
  explanation: string;
  toolsUsed: string[];
  model: string;
  sources?: Array<{ path: string; chunk: number; score: number }>;
  orchestration?: 'single_agent' | 'supervisor';
  specialistReports?: Array<{
    agent: string;
    summary: string;
    findings: string[];
    confidence: number;
    proposedAction?: string;
    risk?: string;
  }>;
};

type AgentExecution = {
  thread_id: string;
  run_id: string;
  model: string;
  status: string;
  started_at: string;
  finished_at?: string;
  events: Array<{
    id: string;
    node: string;
    status: string;
    details: Record<string, unknown>;
    created_at: string;
  }>;
};

type Failure = {
  fingerprint: string;
  test_id: string;
  title: string;
  suite: string;
  run_count: number;
  fail_count: number;
  pass_count: number;
  last_statuses: Array<'passed' | 'failed' | 'skipped'>;
  consecutive_passes: number;
  jira_issue_key?: string;
  classification?: string;
  agent_investigation?: AgentInvestigation;
  last_seen_at: string;
};

type Run = {
  run_id: string;
  repository: string;
  branch: string;
  commit_sha: string;
  environment: string;
  summary: { total: number; passed: number; failed: number; skipped: number };
  created_at: string;
};

type JiraIssue = {
  key: string;
  fields: {
    summary: string;
    description?: string;
    status: { name: string };
    labels: string[];
    priority?: { name?: string };
  };
  comments: Array<{ body: string; created: string }>;
  created: string;
};

type SlackMessage = {
  id: string;
  channel: string;
  payload: { text?: string; blocks?: Array<{ text?: { text?: string } }> };
  receivedAt: string;
};

type ApprovalRequest = {
  id: string;
  thread_id: string;
  fingerprint: string;
  test_id: string;
  classification: string;
  requested_action: string;
  status: string;
  investigation: AgentInvestigation;
  created_at: string;
};

type KnowledgeMatch = { sourcePath: string; chunkIndex: number; content: string; score: number };
type KnowledgeStatus = {
  chunkCount: number;
  sourceCount: number;
  latestRun?: { status: string; embedding_model: string; finished_at?: string };
};

type ObservabilitySummary = {
  window: string;
  executions: { total: number; completed: number; failed: number; paused: number; avg_duration_ms: number };
  modelCalls: { calls: number; prompt_tokens: number; completion_tokens: number; avg_call_duration_ms: number };
  byNode: Array<{ node: string; calls: number; avg_duration_ms: number; prompt_tokens: number; completion_tokens: number }>;
  recentCalls: Array<{ id: string; node: string; prompt_version: string; model: string; prompt_tokens: number; completion_tokens: number; duration_ms: number; created_at: string }>;
};

type DashboardData = {
  runs: Run[];
  failures: Failure[];
  issues: JiraIssue[];
  messages: SlackMessage[];
  approvals: ApprovalRequest[];
  knowledge: KnowledgeStatus;
  observability: ObservabilitySummary;
};

const emptyObservability: ObservabilitySummary = {
  window: '24h', executions: { total: 0, completed: 0, failed: 0, paused: 0, avg_duration_ms: 0 },
  modelCalls: { calls: 0, prompt_tokens: 0, completion_tokens: 0, avg_call_duration_ms: 0 }, byNode: [], recentCalls: [],
};
const emptyData: DashboardData = { runs: [], failures: [], issues: [], messages: [], approvals: [], knowledge: { chunkCount: 0, sourceCount: 0 }, observability: emptyObservability };

const navItems: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'Command center', icon: LayoutDashboard },
  { id: 'observability', label: 'AI observability', icon: Activity },
  { id: 'approvals', label: 'Approval queue', icon: ShieldCheck },
  { id: 'knowledge', label: 'Knowledge RAG', icon: BookOpen },
  { id: 'investigations', label: 'AI investigations', icon: BrainCircuit },
  { id: 'jira', label: 'Jira activity', icon: TicketCheck },
  { id: 'slack', label: 'Slack signal', icon: MessageSquare },
];

const classificationColor: Record<string, string> = {
  new_regression: '#ff735c',
  known_bug: '#f59e0b',
  flaky: '#eab308',
  infrastructure: '#8b5cf6',
  automation_failure: '#22b8c2',
  possibly_fixed: '#10b981',
  unclassified: '#94a3b8',
};

const classificationStyle: Record<string, string> = {
  new_regression: 'bg-coral/15 text-[#a82e1b] border-coral/40',
  known_bug: 'bg-amber-100 text-amber-800 border-amber-300',
  flaky: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  infrastructure: 'bg-violet-100 text-violet-800 border-violet-300',
  automation_failure: 'bg-cyan/20 text-cyan-900 border-cyan/60',
  possibly_fixed: 'bg-emerald-100 text-emerald-800 border-emerald-300',
};

function formatTime(value?: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function humanize(value?: string) {
  return (value ?? 'unclassified').replaceAll('_', ' ');
}

function Badge({ value }: { value?: string }) {
  return (
    <span
      className={`inline-flex border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide ${classificationStyle[value ?? ''] ?? 'border-slate-300 bg-slate-100 text-slate-700'}`}
    >
      {humanize(value)}
    </span>
  );
}

function Metric({
  label,
  value,
  note,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  note: string;
  icon: typeof Activity;
  accent: string;
}) {
  return (
    <article className="panel-hover relative overflow-hidden border border-ink/10 bg-white p-5 shadow-panel">
      <div className={`absolute inset-x-0 top-0 h-1 ${accent}`} />
      <div className="flex items-start justify-between">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">{label}</p>
        <Icon size={19} strokeWidth={1.8} className="text-slate-500" />
      </div>
      <p className="mt-5 text-4xl font-extrabold tracking-[-0.05em] text-ink">{value}</p>
      <p className="mt-2 text-xs text-slate-500">{note}</p>
    </article>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center border border-dashed border-slate-300 bg-white/60 p-8 text-center">
      <CircleDot className="mb-3 text-slate-400" size={26} />
      <p className="font-semibold text-slate-700">No {label} yet</p>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        Run a demo scenario, then refresh this view.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-5 py-7" aria-label="Loading dashboard">
      <div className="h-40 animate-pulse bg-white/80" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="h-36 animate-pulse border border-ink/5 bg-white/80" />
        ))}
      </div>
      <div className="h-80 animate-pulse border border-ink/5 bg-white/80" />
    </div>
  );
}

function ClassificationDistribution({ failures }: { failures: Failure[] }) {
  const counts = Object.entries(
    failures.reduce<Record<string, number>>((result, failure) => {
      const key = failure.classification ?? 'unclassified';
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {})
  ).sort(([, first], [, second]) => second - first);
  const total = Math.max(failures.length, 1);

  return (
    <article className="panel-hover border border-ink/10 bg-white p-5 shadow-panel">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold">Signal composition</h2>
          <p className="mt-1 text-xs text-slate-500">Classification mix by unique fingerprint</p>
        </div>
        <BarChart3 size={19} className="text-slate-400" />
      </div>
      {counts.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">No classified signals yet.</p>
      ) : (
        <div className="mt-6 space-y-4">
          {counts.map(([classification, count]) => (
            <div key={classification}>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="font-semibold capitalize">{humanize(classification)}</span>
                <span className="font-mono text-[10px] text-slate-500">
                  {count} / {failures.length}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden bg-slate-100">
                <div
                  className="h-full transition-all duration-700"
                  style={{
                    width: `${Math.max((count / total) * 100, 3)}%`,
                    backgroundColor:
                      classificationColor[classification] ?? classificationColor.unclassified,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function App() {
  const [view, setView] = useState<View>('overview');
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastRefresh, setLastRefresh] = useState<Date>();
  const [query, setQuery] = useState('');
  const [selectedFailure, setSelectedFailure] = useState<Failure>();
  const [agentExecutions, setAgentExecutions] = useState<AgentExecution[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [reviewer, setReviewer] = useState('local-operator');
  const [decidingThread, setDecidingThread] = useState<string>();
  const [knowledgeQuery, setKnowledgeQuery] = useState('How are webhook payloads validated?');
  const [knowledgeMatches, setKnowledgeMatches] = useState<KnowledgeMatch[]>([]);
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);

  useEffect(() => {
    if (!selectedFailure) return;
    const controller = new AbortController();
    fetch(`/api/ingestion/api/failures/${selectedFailure.fingerprint}/agent-executions`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load agent audit');
        return response.json() as Promise<{ executions?: AgentExecution[] }>;
      })
      .then((payload) => setAgentExecutions(payload.executions ?? []))
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
        setAgentExecutions([]);
      })
      .finally(() => setAuditLoading(false));
    return () => controller.abort();
  }, [selectedFailure]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const responses = await Promise.all([
        fetch('/api/ingestion/api/runs?limit=50'),
        fetch('/api/ingestion/api/failures?limit=100'),
        fetch('/api/mock/jira/issues'),
        fetch('/api/mock/slack/messages'),
        fetch('/api/ingestion/api/approvals?status=pending'),
        fetch('/api/ingestion/api/knowledge/status'),
        fetch('/api/ingestion/api/observability/summary'),
      ]);
      if (responses.some((response) => !response.ok))
        throw new Error('One or more services are unavailable');
      const [runs, failures, issues, messages, approvals, knowledge, observability] = await Promise.all(
        responses.map((response) => response.json())
      );
      setData({
        runs: runs.runs ?? [],
        failures: failures.failures ?? [],
        issues: issues.issues ?? [],
        messages: messages.messages ?? [],
        approvals: approvals.approvals ?? [],
        knowledge,
        observability,
      });
      setError(undefined);
      setLastRefresh(new Date());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load dashboard data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadData(), 0);
    const interval = window.setInterval(() => void loadData(), 15_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadData]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedFailure(undefined);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  const investigations = useMemo(
    () => data.failures.filter((failure) => failure.agent_investigation),
    [data.failures]
  );
  const averageConfidence = investigations.length
    ? Math.round(
        (investigations.reduce(
          (sum, failure) => sum + (failure.agent_investigation?.confidence ?? 0),
          0
        ) /
          investigations.length) *
          100
      )
    : 0;
  const successfulRuns = data.runs.filter((run) => run.summary.failed === 0).length;
  const runHealth = data.runs.length ? Math.round((successfulRuns / data.runs.length) * 100) : 100;
  const initialLoading = loading && !lastRefresh;
  const navCount: Record<View, number | undefined> = {
    overview: undefined,
    observability: data.observability.modelCalls.calls,
    approvals: data.approvals.length,
    knowledge: data.knowledge.chunkCount,
    investigations: investigations.length,
    jira: data.issues.length,
    slack: data.messages.length,
  };

  const decideApproval = async (threadId: string, decision: 'approved' | 'rejected') => {
    setDecidingThread(threadId);
    try {
      const response = await fetch(
        `/api/ingestion/api/approvals/${encodeURIComponent(threadId)}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, reviewer }),
        }
      );
      if (!response.ok) throw new Error('Approval decision failed');
      await loadData();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Approval decision failed');
    } finally {
      setDecidingThread(undefined);
    }
  };

  const searchKnowledge = async () => {
    if (knowledgeQuery.trim().length < 3) return;
    setKnowledgeBusy(true);
    try {
      const response = await fetch('/api/ingestion/api/knowledge/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: knowledgeQuery, topK: 5 }),
      });
      if (!response.ok) throw new Error('Knowledge search failed');
      const payload = (await response.json()) as { matches?: KnowledgeMatch[] };
      setKnowledgeMatches(payload.matches ?? []);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : 'Knowledge search failed');
    } finally {
      setKnowledgeBusy(false);
    }
  };

  const reindexKnowledge = async () => {
    setKnowledgeBusy(true);
    try {
      const response = await fetch('/api/ingestion/api/knowledge/reindex', { method: 'POST' });
      if (!response.ok) throw new Error('Knowledge reindex failed');
      await loadData();
    } catch (reindexError) {
      setError(reindexError instanceof Error ? reindexError.message : 'Knowledge reindex failed');
    } finally {
      setKnowledgeBusy(false);
    }
  };
  const filteredFailures = data.failures.filter((failure) =>
    `${failure.title} ${failure.test_id} ${failure.classification}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-canvas text-ink lg:grid lg:grid-cols-[250px_1fr]">
      <aside className="flex flex-col bg-ink px-5 py-6 text-white lg:sticky lg:top-0 lg:h-screen">
        <div className="flex items-center gap-3 border-b border-white/10 pb-6">
          <div className="grid h-10 w-10 place-items-center bg-signal text-ink">
            <Zap size={20} fill="currentColor" />
          </div>
          <div>
            <p className="text-lg font-extrabold tracking-tight">SignalOps</p>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/45">
              Agentic reliability
            </p>
          </div>
        </div>

        <nav className="mt-7 grid grid-cols-2 gap-2 lg:block lg:space-y-1">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              aria-current={view === id ? 'page' : undefined}
              className={`flex w-full items-center gap-3 px-3 py-3 text-left text-sm transition ${view === id ? 'bg-white text-ink' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}
            >
              <Icon size={17} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {navCount[id] !== undefined && (
                <span
                  className={`min-w-6 px-1.5 py-0.5 text-center font-mono text-[9px] ${view === id ? 'bg-ink text-white' : 'bg-white/10 text-white/65'}`}
                >
                  {navCount[id]}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="mt-7 border border-white/10 bg-white/[0.04] p-4 lg:mt-auto">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <span
              className={`h-2 w-2 rounded-full ${error ? 'bg-coral' : 'signal-pulse bg-signal'}`}
            />
            {error ? 'Degraded' : 'Systems online'}
          </div>
          <div className="mt-4 space-y-2 font-mono text-[10px] text-white/45">
            <p className="flex justify-between">
              <span>POLICY</span>
              <span>GUARDED</span>
            </p>
            <p className="flex justify-between">
              <span>MODEL</span>
              <span>LOCAL</span>
            </p>
            <p className="flex justify-between">
              <span>REFRESH</span>
              <span>15 SEC</span>
            </p>
          </div>
        </div>
      </aside>

      <main className="grid-noise min-w-0 overflow-hidden px-4 py-5 sm:px-7 lg:px-10 lg:py-8">
        <header className="flex flex-col gap-5 border-b border-ink/15 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              <ShieldCheck size={13} /> Guarded AI operations
            </p>
            <h1 className="text-3xl font-extrabold tracking-[-0.04em] sm:text-4xl">
              {navItems.find((item) => item.id === view)?.label}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[10px] uppercase text-slate-500 sm:block">
              Updated {lastRefresh ? lastRefresh.toLocaleTimeString() : '—'}
            </span>
            <button
              onClick={() => void loadData()}
              disabled={loading}
              className="flex items-center gap-2 border border-ink bg-ink px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-white disabled:opacity-60"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-5 flex items-center gap-3 border-l-4 border-coral bg-red-50 p-4 text-sm text-red-900">
            <AlertTriangle size={18} /> {error}. Existing data remains visible.
          </div>
        )}

        {initialLoading && <LoadingState />}

        {!initialLoading && view === 'overview' && (
          <div className="page-enter space-y-7 py-7">
            <section className="relative overflow-hidden bg-ink px-6 py-7 text-white shadow-panel sm:px-8 sm:py-8">
              <div className="absolute -right-16 -top-24 h-72 w-72 rounded-full border-[42px] border-white/[0.04]" />
              <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_auto]">
                <div>
                  <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-signal">
                    <span className="h-1.5 w-1.5 rounded-full bg-signal signal-pulse" /> Live
                    operational posture
                  </p>
                  <h2 className="mt-4 max-w-3xl text-3xl font-extrabold leading-tight tracking-[-0.045em] sm:text-4xl">
                    Failures become decisions,
                    <span className="text-white/45"> not ticket noise.</span>
                  </h2>
                  <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3 font-mono text-[10px] uppercase tracking-wide text-white/55">
                    <span className="flex items-center gap-2">
                      <Database size={13} className="text-signal" /> PostgreSQL state
                    </span>
                    <span className="flex items-center gap-2">
                      <Network size={13} className="text-cyan" /> 2 bounded tools
                    </span>
                    <span className="flex items-center gap-2">
                      <Clock3 size={13} className="text-coral" /> 15s telemetry
                    </span>
                  </div>
                </div>
                <div className="relative grid h-36 w-36 shrink-0 place-items-center">
                  <div
                    className="absolute inset-0 rounded-full"
                    style={{
                      background: `conic-gradient(#d7ff3f ${runHealth * 3.6}deg, rgba(255,255,255,.09) 0deg)`,
                    }}
                  />
                  <div className="absolute inset-[10px] rounded-full bg-ink" />
                  <div className="relative text-center">
                    <p className="font-mono text-3xl font-semibold text-signal">{runHealth}%</p>
                    <p className="mt-1 font-mono text-[8px] uppercase tracking-[0.18em] text-white/45">
                      run health
                    </p>
                  </div>
                </div>
              </div>
            </section>
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                label="CI runs"
                value={data.runs.length}
                note="Recent persisted executions"
                icon={Activity}
                accent="bg-ink"
              />
              <Metric
                label="Failure signals"
                value={data.failures.length}
                note="Unique normalized fingerprints"
                icon={Bug}
                accent="bg-coral"
              />
              <Metric
                label="AI investigations"
                value={investigations.length}
                note="Persisted agent decisions"
                icon={BrainCircuit}
                accent="bg-signal"
              />
              <Metric
                label="Agent confidence"
                value={`${averageConfidence}%`}
                note="Average structured confidence"
                icon={Sparkles}
                accent="bg-cyan"
              />
            </section>

            <section className="grid gap-6 xl:grid-cols-[1.45fr_0.8fr]">
              <div className="panel-hover border border-ink/10 bg-white shadow-panel">
                <div className="flex flex-col gap-3 border-b border-ink/10 p-5 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="font-bold">Failure intelligence</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      History-aware classifications across the system
                    </p>
                  </div>
                  <label className="flex items-center gap-2 border border-slate-300 bg-canvas px-3 py-2">
                    <Search size={14} className="text-slate-500" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Filter signals"
                      className="w-36 bg-transparent text-xs outline-none"
                    />
                  </label>
                </div>
                <div className="max-h-[520px] overflow-auto scrollbar-thin">
                  {filteredFailures.length === 0 ? (
                    <EmptyState label="failure signals" />
                  ) : (
                    filteredFailures.map((failure) => (
                      <button
                        key={failure.fingerprint}
                        onClick={() => {
                          setAgentExecutions([]);
                          setAuditLoading(true);
                          setSelectedFailure(failure);
                        }}
                        className="grid w-full gap-3 border-b border-slate-100 p-4 text-left transition hover:bg-lime-50 sm:grid-cols-[1fr_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge value={failure.classification} />
                            {failure.agent_investigation && (
                              <span className="flex items-center gap-1 font-mono text-[10px] text-emerald-700">
                                <Bot size={12} /> investigated
                              </span>
                            )}
                          </div>
                          <p className="mt-2 truncate text-sm font-bold">{failure.title}</p>
                          <p className="mt-1 truncate font-mono text-[10px] text-slate-500">
                            {failure.fingerprint.slice(0, 18)} · {failure.suite}
                          </p>
                        </div>
                        <div className="flex items-center gap-5 text-xs text-slate-500">
                          <span>
                            <b className="text-ink">{failure.run_count}</b> runs
                          </span>
                          <span>{formatTime(failure.last_seen_at)}</span>
                          <ChevronRight size={16} />
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="space-y-6">
                <ClassificationDistribution failures={data.failures} />
                <div className="panel-hover border border-ink/10 bg-ink p-5 text-white shadow-panel">
                  <div className="flex items-center justify-between">
                    <h2 className="font-bold">Agent control plane</h2>
                    <BrainCircuit className="text-signal" size={21} />
                  </div>
                  <div className="mt-6 grid grid-cols-2 gap-px bg-white/10">
                    <div className="bg-ink p-4">
                      <p className="font-mono text-[9px] text-white/45">AUTONOMY</p>
                      <p className="mt-2 font-bold text-signal">Guarded</p>
                    </div>
                    <div className="bg-ink p-4">
                      <p className="font-mono text-[9px] text-white/45">TOOLS</p>
                      <p className="mt-2 font-bold">2 bounded</p>
                    </div>
                    <div className="bg-ink p-4">
                      <p className="font-mono text-[9px] text-white/45">FALLBACK</p>
                      <p className="mt-2 font-bold">Deterministic</p>
                    </div>
                    <div className="bg-ink p-4">
                      <p className="font-mono text-[9px] text-white/45">INFERENCE</p>
                      <p className="mt-2 font-bold">Local</p>
                    </div>
                  </div>
                </div>

                <div className="panel-hover border border-ink/10 bg-white p-5 shadow-panel">
                  <h2 className="font-bold">Latest runs</h2>
                  <div className="mt-4 space-y-4">
                    {data.runs.slice(0, 5).map((run) => (
                      <div key={run.run_id} className="border-l-2 border-ink pl-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-xs font-bold">{run.repository}</p>
                          {run.summary.failed > 0 ? (
                            <XCircle size={15} className="text-coral" />
                          ) : (
                            <CheckCircle2 size={15} className="text-emerald-600" />
                          )}
                        </div>
                        <p className="mt-1 flex items-center gap-1 font-mono text-[9px] text-slate-500">
                          <GitBranch size={10} /> {run.branch} · {formatTime(run.created_at)}
                        </p>
                      </div>
                    ))}
                    {data.runs.length === 0 && (
                      <p className="text-sm text-slate-500">No runs persisted yet.</p>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {!initialLoading && view === 'investigations' && (
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
                        <h2 className="mt-3 text-lg font-extrabold tracking-tight">
                          {failure.title}
                        </h2>
                      </div>
                      <div className="grid h-14 w-14 shrink-0 place-items-center bg-signal font-mono text-sm font-bold">
                        {Math.round(agent.confidence * 100)}%
                      </div>
                    </div>
                    <div className="mt-5 border-l-4 border-signal bg-lime-50 p-4">
                      <p className="font-mono text-[9px] font-semibold uppercase tracking-widest text-slate-500">
                        Suspected root cause
                      </p>
                      <p className="mt-2 text-sm font-bold">{agent.suspectedRootCause}</p>
                    </div>
                    <p className="mt-4 text-sm leading-6 text-slate-600">{agent.explanation}</p>
                    {agent.specialistReports && agent.specialistReports.length > 0 && (
                      <div className="mt-5 grid gap-2 sm:grid-cols-3">
                        {agent.specialistReports.map((report) => (
                          <div key={report.agent} className="border border-violet-200 bg-violet-50/60 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-[9px] font-bold uppercase text-violet-800">{report.agent} agent</span>
                              <span className="font-mono text-[9px] text-violet-600">{Math.round(report.confidence * 100)}%</span>
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
                      <span className="ml-auto font-mono text-[9px] text-slate-500">
                        {agent.model}
                      </span>
                    </div>
                    {agent.sources && agent.sources.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {agent.sources.map((source) => (
                          <span key={`${source.path}-${source.chunk}`} className="border border-cyan/50 bg-cyan/10 px-2 py-1 font-mono text-[9px] text-cyan-900">
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
        )}

        {!initialLoading && view === 'approvals' && (
          <section className="page-enter py-7">
            <div className="mb-6 flex flex-col gap-3 border border-ink/10 bg-white p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-bold">Human control plane</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Decisions resume the exact persisted LangGraph thread.
                </p>
              </div>
              <label className="flex items-center gap-3 text-xs font-bold">
                Reviewer
                <input
                  value={reviewer}
                  onChange={(event) => setReviewer(event.target.value)}
                  className="w-48 border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-ink"
                />
              </label>
            </div>
            {data.approvals.length === 0 ? (
              <EmptyState label="pending approvals" />
            ) : (
              <div className="grid gap-5 xl:grid-cols-2">
                {data.approvals.map((approval) => (
                  <article key={approval.thread_id} className="border border-ink/10 bg-white p-5 shadow-panel">
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
                      <p className="font-mono text-[9px] uppercase text-slate-500">Agent recommendation</p>
                      <p className="mt-2 text-sm font-bold">{approval.investigation.suspectedRootCause}</p>
                      <p className="mt-2 text-xs leading-5 text-slate-600">{approval.investigation.explanation}</p>
                    </div>
                    <div className="mt-4 flex items-center justify-between font-mono text-[9px] text-slate-500">
                      <span>{approval.requested_action}</span>
                      <span>{Math.round(approval.investigation.confidence * 100)}% confidence</span>
                    </div>
                    <div className="mt-5 grid grid-cols-2 gap-3 border-t border-slate-200 pt-5">
                      <button
                        onClick={() => void decideApproval(approval.thread_id, 'rejected')}
                        disabled={!reviewer.trim() || decidingThread === approval.thread_id}
                        className="border border-ink px-4 py-2.5 text-xs font-bold disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => void decideApproval(approval.thread_id, 'approved')}
                        disabled={!reviewer.trim() || decidingThread === approval.thread_id}
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
        )}

        {!initialLoading && view === 'observability' && (
          <section className="page-enter space-y-6 py-7">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Agent executions" value={data.observability.executions.total} note={`${data.observability.window} persisted runs`} icon={Network} accent="bg-ink" />
              <Metric label="Model calls" value={data.observability.modelCalls.calls} note="Specialists + supervisor" icon={BrainCircuit} accent="bg-violet-500" />
              <Metric label="Total tokens" value={data.observability.modelCalls.prompt_tokens + data.observability.modelCalls.completion_tokens} note={`${data.observability.modelCalls.prompt_tokens} prompt / ${data.observability.modelCalls.completion_tokens} completion`} icon={Sparkles} accent="bg-signal" />
              <Metric label="Avg call latency" value={`${Math.round(data.observability.modelCalls.avg_call_duration_ms)}ms`} note="Measured wall-clock duration" icon={Clock3} accent="bg-cyan" />
            </div>
            <div className="grid gap-6 xl:grid-cols-[1fr_1.2fr]">
              <article className="border border-ink/10 bg-white p-5 shadow-panel">
                <h2 className="font-bold">Node performance</h2>
                <p className="mt-1 text-xs text-slate-500">Prompt lineage, latency, and token consumption by role</p>
                <div className="mt-5 space-y-3">
                  {data.observability.byNode.map((node) => (
                    <div key={node.node} className="border-l-4 border-violet-400 bg-violet-50 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-bold uppercase">{node.node}</span>
                        <span className="font-mono text-[10px]">{Math.round(node.avg_duration_ms)}ms avg</span>
                      </div>
                      <p className="mt-2 font-mono text-[9px] text-slate-500">{node.calls} calls · {node.prompt_tokens} prompt · {node.completion_tokens} completion tokens</p>
                    </div>
                  ))}
                  {data.observability.byNode.length === 0 && <p className="text-sm text-slate-500">Run an AI scenario to capture model telemetry.</p>}
                </div>
              </article>
              <article className="overflow-hidden border border-ink/10 bg-white shadow-panel">
                <div className="border-b border-slate-200 p-5">
                  <h2 className="font-bold">Recent model calls</h2>
                  <p className="mt-1 text-xs text-slate-500">Traceable model and prompt versions per graph node</p>
                </div>
                <div className="max-h-[430px] overflow-auto">
                  {data.observability.recentCalls.map((call) => (
                    <div key={call.id} className="grid grid-cols-[1fr_auto] gap-4 border-b border-slate-100 p-4">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold">{call.node}</p>
                        <p className="mt-1 font-mono text-[9px] text-violet-700">{call.prompt_version} · {call.model}</p>
                      </div>
                      <div className="text-right font-mono text-[9px] text-slate-500">
                        <p>{call.duration_ms}ms</p>
                        <p>{call.prompt_tokens + call.completion_tokens} tokens</p>
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            </div>
          </section>
        )}

        {!initialLoading && view === 'knowledge' && (
          <section className="page-enter space-y-6 py-7">
            <div className="grid gap-4 sm:grid-cols-3">
              <Metric label="Indexed chunks" value={data.knowledge.chunkCount} note="LlamaIndex sentence chunks" icon={Database} accent="bg-signal" />
              <Metric label="Sources" value={data.knowledge.sourceCount} note="Allowlisted repository files" icon={BookOpen} accent="bg-cyan" />
              <Metric label="Embedding" value={data.knowledge.latestRun?.status ?? 'not indexed'} note={data.knowledge.latestRun?.embedding_model ?? 'nomic-embed-text'} icon={BrainCircuit} accent="bg-violet-500" />
            </div>
            <div className="border border-ink/10 bg-white p-5 shadow-panel">
              <div className="flex flex-col gap-4 lg:flex-row">
                <input
                  value={knowledgeQuery}
                  onChange={(event) => setKnowledgeQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void searchKnowledge(); }}
                  className="min-w-0 flex-1 border border-slate-300 px-4 py-3 text-sm outline-none focus:border-ink"
                  placeholder="Search repository knowledge"
                />
                <button onClick={() => void searchKnowledge()} disabled={knowledgeBusy} className="bg-ink px-5 py-3 text-xs font-bold text-signal disabled:opacity-50">
                  Semantic search
                </button>
                <button onClick={() => void reindexKnowledge()} disabled={knowledgeBusy} className="border border-ink px-5 py-3 text-xs font-bold disabled:opacity-50">
                  Reindex repository
                </button>
              </div>
            </div>
            {knowledgeMatches.length > 0 && (
              <div className="grid gap-4 lg:grid-cols-2">
                {knowledgeMatches.map((match) => (
                  <article key={`${match.sourcePath}-${match.chunkIndex}`} className="border border-ink/10 bg-white p-5 shadow-panel">
                    <div className="flex items-center justify-between gap-3 font-mono text-[9px]">
                      <span className="truncate font-bold text-cyan-800">{match.sourcePath}#{match.chunkIndex}</span>
                      <span className="shrink-0 bg-signal px-2 py-1 text-ink">{Math.round(match.score * 100)}%</span>
                    </div>
                    <p className="mt-4 line-clamp-6 whitespace-pre-wrap text-xs leading-5 text-slate-600">{match.content}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {!initialLoading && view === 'jira' && (
          <section className="page-enter py-7">
            {data.issues.length === 0 ? (
              <EmptyState label="Jira issues" />
            ) : (
              <div className="grid gap-5 lg:grid-cols-2">
                {data.issues.map((issue) => (
                  <article
                    key={issue.key}
                    className="border border-ink/10 bg-white p-5 shadow-panel"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="bg-[#1769e0] px-2.5 py-1 font-mono text-xs font-bold text-white">
                        {issue.key}
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-slate-500">
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
                    <div className="mt-5 flex items-center justify-between border-t border-slate-200 pt-4 text-xs text-slate-500">
                      <span>{issue.comments?.length ?? 0} comments</span>
                      <span>{formatTime(issue.created)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {!initialLoading && view === 'slack' && (
          <section className="page-enter py-7">
            {data.messages.length === 0 ? (
              <EmptyState label="Slack notifications" />
            ) : (
              <div className="mx-auto max-w-4xl border border-ink/10 bg-white shadow-panel">
                <div className="flex items-center gap-3 border-b border-slate-200 bg-[#4a154b] p-5 text-white">
                  <MessageSquare size={20} />
                  <div>
                    <h2 className="font-bold">#ci-failure-intelligence</h2>
                    <p className="text-xs text-white/60">Automation signal stream</p>
                  </div>
                </div>
                <div className="divide-y divide-slate-100">
                  {[...data.messages].reverse().map((message) => {
                    const body =
                      message.payload.blocks?.[0]?.text?.text ??
                      message.payload.text ??
                      JSON.stringify(message.payload);
                    return (
                      <article key={message.id} className="flex gap-4 p-5">
                        <div className="grid h-10 w-10 shrink-0 place-items-center bg-ink text-signal">
                          <Bot size={19} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <p className="text-sm font-bold">SignalOps Agent</p>
                            <span className="font-mono text-[9px] text-slate-400">
                              {formatTime(message.receivedAt)}
                            </span>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                            {body.replaceAll('*', '').replaceAll('`', '')}
                          </p>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      {selectedFailure && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-ink/45 backdrop-blur-sm"
          onClick={() => setSelectedFailure(undefined)}
          role="presentation"
        >
          <aside
            className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl scrollbar-thin"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Failure dossier for ${selectedFailure.title}`}
          >
            <button
              onClick={() => setSelectedFailure(undefined)}
              className="float-right border border-ink px-3 py-1.5 text-xs font-bold"
            >
              Close
            </button>
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              Failure dossier
            </p>
            <h2 className="mt-4 pr-20 text-2xl font-extrabold tracking-tight">
              {selectedFailure.title}
            </h2>
            <div className="mt-4">
              <Badge value={selectedFailure.classification} />
            </div>
            <dl className="mt-7 grid grid-cols-2 gap-px bg-slate-200 border border-slate-200">
              {[
                ['Fingerprint', selectedFailure.fingerprint.slice(0, 16)],
                ['Run count', String(selectedFailure.run_count)],
                ['Failures', String(selectedFailure.fail_count)],
                ['Passes', String(selectedFailure.pass_count)],
                ['Jira', selectedFailure.jira_issue_key ?? 'Not linked'],
                ['Last seen', formatTime(selectedFailure.last_seen_at)],
              ].map(([label, value]) => (
                <div key={label} className="bg-white p-4">
                  <dt className="font-mono text-[9px] uppercase text-slate-400">{label}</dt>
                  <dd className="mt-1 truncate text-xs font-bold">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-7">
              <h3 className="text-xs font-bold uppercase tracking-wide">
                Recent state transitions
              </h3>
              <div className="mt-3 flex gap-2">
                {selectedFailure.last_statuses?.map((status, index) => (
                  <span
                    key={`${status}-${index}`}
                    title={status}
                    className={`h-3 flex-1 ${status === 'passed' ? 'bg-emerald-500' : status === 'failed' ? 'bg-coral' : 'bg-slate-300'}`}
                  />
                ))}
              </div>
            </div>
            {selectedFailure.agent_investigation ? (
              <div className="mt-8 border-t border-ink pt-6">
                <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
                  <BrainCircuit size={14} /> Agent investigation
                </p>
                <h3 className="mt-4 text-xl font-extrabold">
                  {selectedFailure.agent_investigation.suspectedRootCause}
                </h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  {selectedFailure.agent_investigation.explanation}
                </p>
                <div className="mt-5 bg-ink p-5 text-white">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold">Confidence</span>
                    <span className="font-mono text-xl text-signal">
                      {Math.round(selectedFailure.agent_investigation.confidence * 100)}%
                    </span>
                  </div>
                  <div className="mt-3 h-1.5 bg-white/15">
                    <div
                      className="h-full bg-signal"
                      style={{ width: `${selectedFailure.agent_investigation.confidence * 100}%` }}
                    />
                  </div>
                </div>
                {selectedFailure.agent_investigation.specialistReports && selectedFailure.agent_investigation.specialistReports.length > 0 && (
                  <div className="mt-5">
                    <p className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Supervisor team reports</p>
                    <div className="mt-3 grid gap-3">
                      {selectedFailure.agent_investigation.specialistReports.map((report) => (
                        <div key={report.agent} className="border-l-4 border-violet-400 bg-violet-50 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-xs font-bold uppercase">{report.agent} specialist</span>
                            <span className="font-mono text-[10px] text-violet-700">{Math.round(report.confidence * 100)}%</span>
                          </div>
                          <p className="mt-2 text-xs leading-5 text-slate-600">{report.summary}</p>
                          {report.risk && <span className="mt-2 inline-block border border-violet-300 px-2 py-0.5 font-mono text-[9px] uppercase">risk: {report.risk}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {selectedFailure.agent_investigation.sources && selectedFailure.agent_investigation.sources.length > 0 && (
                  <div className="mt-5">
                    <p className="font-mono text-[9px] uppercase tracking-widest text-slate-500">Retrieved sources</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedFailure.agent_investigation.sources.map((source) => (
                        <span key={`${source.path}-${source.chunk}`} className="border border-cyan/50 bg-cyan/10 px-2 py-1 font-mono text-[9px] text-cyan-900">
                          {source.path}#{source.chunk} · {Math.round(source.score * 100)}%
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-8 border border-dashed border-slate-300 p-5 text-sm text-slate-500">
                No persisted agent investigation for this historical signal. Run a new scenario with
                AI enabled.
              </div>
            )}
            <div className="mt-8 border-t border-ink pt-6">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
                  <Network size={14} /> LangGraph execution timeline
                </p>
                {agentExecutions[0] && (
                  <span className="border border-emerald-300 bg-emerald-50 px-2 py-1 font-mono text-[9px] uppercase text-emerald-700">
                    {agentExecutions[0].status}
                  </span>
                )}
              </div>
              {auditLoading ? (
                <div className="mt-4 h-24 animate-pulse bg-slate-100" />
              ) : agentExecutions.length > 0 ? (
                <div className="mt-5">
                  <div className="mb-4 flex items-center justify-between text-[10px] text-slate-500">
                    <span className="font-mono">{agentExecutions[0].model}</span>
                    <span>{formatTime(agentExecutions[0].started_at)}</span>
                  </div>
                  <ol className="relative border-l border-slate-300 pl-5">
                    {agentExecutions[0].events.map((event) => (
                      <li key={event.id} className="relative pb-5 last:pb-0">
                        <span className="absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-cyan shadow-sm" />
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-xs font-bold">{humanize(event.node)}</span>
                          <span className="font-mono text-[9px] uppercase text-slate-400">
                            {event.status}
                          </span>
                        </div>
                        {Object.keys(event.details).length > 0 && (
                          <p className="mt-1 break-words font-mono text-[9px] leading-4 text-slate-500">
                            {JSON.stringify(event.details)}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-500">
                  No checkpoint-backed execution is available for this historical signal yet.
                </p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
