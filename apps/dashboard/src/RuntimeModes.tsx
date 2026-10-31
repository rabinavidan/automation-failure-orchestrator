import { useEffect, useState } from 'react';

export type ModelBackend = 'disabled' | 'stub' | 'real' | 'unreachable';

export type RuntimeCapabilities = {
  model: {
    configured: 'disabled' | 'enabled';
    backend: ModelBackend;
    model: string;
    modelInstalled: boolean | null;
    orchestration: string;
    graphVersion: string;
    ragEnabled: boolean;
    detail?: string;
  };
  integrations: { mode: 'mock' | 'live'; jiraTarget: string | null };
  queue: { mode: 'in_process' | 'sqs_local_emulator' | 'sqs_aws' };
  enrichment: { configured: boolean; available: boolean; mode: string | null };
  notes: string[];
};

const backendStyle: Record<ModelBackend, string> = {
  real: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  stub: 'border-amber-400 bg-amber-50 text-amber-900',
  disabled: 'border-slate-300 bg-slate-50 text-slate-700',
  unreachable: 'border-red-300 bg-red-50 text-red-800',
};

const backendLabel: Record<ModelBackend, string> = {
  real: 'Real local model',
  stub: 'Demo stub (not real AI)',
  disabled: 'AI disabled (deterministic only)',
  unreachable: 'Model unreachable (deterministic fallback)',
};

const queueLabel: Record<RuntimeCapabilities['queue']['mode'], string> = {
  in_process: 'In-process queue',
  sqs_local_emulator: 'SQS on local emulator',
  sqs_aws: 'AWS SQS',
};

/** Badge for one investigation's recorded backend; unknown (pre-migration) rows are labeled so. */
export function BackendBadge({ backend }: { backend?: string | null }) {
  const known = backend && backend in backendStyle ? (backend as ModelBackend) : undefined;
  return (
    <span
      className={`border px-2 py-0.5 font-mono text-[9px] uppercase ${
        known ? backendStyle[known] : 'border-slate-300 bg-white text-slate-500'
      }`}
      title={known ? backendLabel[known] : 'Recorded before backend tracking; treat as unverified'}
    >
      {known ?? 'backend unknown'}
    </span>
  );
}

/** Header strip with configured mode vs. current availability for each runtime dimension. */
export function RuntimeModes() {
  const [caps, setCaps] = useState<RuntimeCapabilities>();
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/ingestion/api/capabilities')
        .then((response) => {
          if (!response.ok) throw new Error(String(response.status));
          return response.json() as Promise<RuntimeCapabilities>;
        })
        .then((body) => {
          if (cancelled) return;
          setCaps(body);
          setState('ok');
        })
        .catch(() => {
          if (!cancelled) setState('error');
        });
    void load();
    const interval = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (state === 'loading' && !caps) {
    return (
      <div
        className="mt-4 h-7 w-full max-w-xl animate-pulse bg-slate-100"
        aria-label="Loading modes"
      />
    );
  }
  if (!caps) {
    return (
      <p role="status" className="mt-4 font-mono text-[10px] uppercase text-red-700">
        Runtime modes unavailable: capability endpoint did not answer
      </p>
    );
  }

  const { model } = caps;
  return (
    <section
      aria-label="Runtime modes"
      className="mt-4 flex flex-wrap items-center gap-2 text-[10px]"
    >
      <span
        className={`border px-2 py-1 font-mono uppercase ${backendStyle[model.backend]}`}
        title={model.detail ?? undefined}
      >
        {backendLabel[model.backend]}
        {model.backend !== 'disabled' && ` · ${model.model}`}
        {model.backend === 'real' && model.modelInstalled === false && ' (not pulled)'}
      </span>
      {model.configured === 'enabled' && (
        <span className="border border-slate-300 bg-white px-2 py-1 font-mono uppercase text-slate-700">
          {model.orchestration === 'supervisor' ? 'Multi-agent' : 'Single agent'} ·{' '}
          {model.graphVersion}
          {model.ragEnabled ? ' · RAG' : ''}
        </span>
      )}
      <span
        className={`border px-2 py-1 font-mono uppercase ${
          caps.integrations.mode === 'mock'
            ? 'border-amber-400 bg-amber-50 text-amber-900'
            : 'border-emerald-300 bg-emerald-50 text-emerald-800'
        }`}
        title={caps.integrations.jiraTarget ?? undefined}
      >
        {caps.integrations.mode === 'mock' ? 'Mock Jira/Slack' : 'Live Jira/Slack'}
      </span>
      <span className="border border-slate-300 bg-white px-2 py-1 font-mono uppercase text-slate-700">
        {queueLabel[caps.queue.mode]}
      </span>
      <span
        className={`border px-2 py-1 font-mono uppercase ${
          caps.enrichment.available
            ? 'border-slate-300 bg-white text-slate-700'
            : 'border-red-300 bg-red-50 text-red-800'
        }`}
      >
        Enrichment{' '}
        {caps.enrichment.available ? (caps.enrichment.mode ?? 'up') : 'unavailable (fail-open)'}
      </span>
      {state === 'error' && (
        <span className="font-mono uppercase text-red-700">stale: refresh failed</span>
      )}
    </section>
  );
}
