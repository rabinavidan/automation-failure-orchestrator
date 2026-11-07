import { useEffect } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck, Zap } from 'lucide-react';
import { useViewData } from './app/data';
import { useRefresh } from './app/refresh-context';
import { RefreshProvider } from './app/refresh';
import { RuntimeModes } from './app/RuntimeModes';
import { navItems, useHashRoute, type View } from './app/routes';
import { useReviewerSession, type ReviewerSession } from './app/useReviewerSession';
import { ApprovalQueue } from './views/approvals/ApprovalQueue';
import { loadPendingApprovals } from './views/approvals/api';
import { JiraActivity } from './views/integrations/JiraActivity';
import { SlackSignal } from './views/integrations/SlackSignal';
import { Investigations } from './views/investigations/Investigations';
import { Knowledge } from './views/knowledge/Knowledge';
import { Observability } from './views/observability/Observability';
import { CommandCenter } from './views/overview/CommandCenter';
import { SocConsole } from './views/soc/SocConsole';

/**
 * The application shell: navigation, header, refresh and the degraded banner. Each view lives
 * in its own folder under views/ and fetches only its own data while it is shown; the URL hash
 * names the view (see app/routes.ts).
 */
function ActiveView({ view, session }: { view: View; session: ReviewerSession }) {
  switch (view) {
    case 'overview':
      return <CommandCenter />;
    case 'soc':
      return <SocConsole session={session} />;
    case 'observability':
      return <Observability />;
    case 'approvals':
      return <ApprovalQueue session={session} />;
    case 'knowledge':
      return <Knowledge session={session} />;
    case 'investigations':
      return <Investigations />;
    case 'jira':
      return <JiraActivity />;
    case 'slack':
      return <SlackSignal />;
  }
}

/** Pending approvals are the one badge kept live on every view: they need a human. */
function usePendingApprovalCount() {
  const { data } = useViewData(loadPendingApprovals);
  const { setCount } = useRefresh();
  useEffect(() => {
    if (data) setCount('approvals', data.length);
  }, [data, setCount]);
}

function Shell() {
  const [view, setView] = useHashRoute();
  const session = useReviewerSession();
  const { pending, error, lastRefresh, counts: navCount, refresh } = useRefresh();
  const loading = pending > 0;
  usePendingApprovalCount();

  return (
    <div className="min-h-screen bg-canvas text-ink lg:grid lg:grid-cols-[250px_1fr]">
      <aside className="flex flex-col bg-ink px-5 py-6 text-white lg:sticky lg:top-0 lg:h-screen">
        <div className="flex items-center gap-3 border-b border-white/10 pb-6">
          <div className="grid h-10 w-10 place-items-center bg-signal text-ink">
            <Zap size={20} fill="currentColor" />
          </div>
          <div>
            <p className="text-lg font-extrabold tracking-tight">SignalOps</p>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/70">
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
              className={`flex w-full items-center gap-3 px-3 py-3 text-left text-sm transition ${view === id ? 'bg-white text-ink' : 'text-white/75 hover:bg-white/10 hover:text-white'}`}
            >
              <Icon size={17} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {navCount[id] !== undefined && (
                <span
                  className={`min-w-6 px-1.5 py-0.5 text-center font-mono text-[9px] ${view === id ? 'bg-ink text-white' : 'bg-white/10 text-white/75'}`}
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
          <div className="mt-4 space-y-2 font-mono text-[10px] text-white/70">
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
            <p className="mb-2 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-600">
              <ShieldCheck size={13} /> Guarded AI operations
            </p>
            <h1 className="text-3xl font-extrabold tracking-[-0.04em] sm:text-4xl">
              {navItems.find((item) => item.id === view)?.label}
            </h1>
            <RuntimeModes />
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[10px] uppercase text-slate-600 sm:block">
              Updated {lastRefresh ? lastRefresh.toLocaleTimeString() : '—'}
            </span>
            <button
              onClick={refresh}
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

        <ActiveView view={view} session={session} />
      </main>
    </div>
  );
}

function App() {
  return (
    <RefreshProvider>
      <Shell />
    </RefreshProvider>
  );
}

export default App;
