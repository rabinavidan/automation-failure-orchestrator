import { Activity, CircleDot } from 'lucide-react';
import { classificationStyle, humanize } from './format';

/** Presentation building blocks shared by every view. */

export function Badge({ value }: { value?: string | null }) {
  return (
    <span
      className={`inline-flex border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide ${classificationStyle[value ?? ''] ?? 'border-slate-300 bg-slate-100 text-slate-700'}`}
    >
      {humanize(value)}
    </span>
  );
}

export function Metric({
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
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-600">{label}</p>
        <Icon size={19} strokeWidth={1.8} className="text-slate-600" />
      </div>
      <p className="mt-5 text-4xl font-extrabold tracking-[-0.05em] text-ink">{value}</p>
      <p className="mt-2 text-xs text-slate-600">{note}</p>
    </article>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center border border-dashed border-slate-300 bg-white/60 p-8 text-center">
      <CircleDot className="mb-3 text-slate-400" size={26} />
      <p className="font-semibold text-slate-700">No {label} yet</p>
      <p className="mt-1 max-w-sm text-sm text-slate-600">
        Run a demo scenario, then refresh this view.
      </p>
    </div>
  );
}

export function LoadingState() {
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
