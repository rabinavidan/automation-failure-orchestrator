/** Formatting helpers and classification colours shared by the views. */

export const classificationColor: Record<string, string> = {
  new_regression: '#ff735c',
  known_bug: '#f59e0b',
  flaky: '#eab308',
  infrastructure: '#8b5cf6',
  automation_failure: '#22b8c2',
  possibly_fixed: '#10b981',
  unclassified: '#94a3b8',
};

export const classificationStyle: Record<string, string> = {
  new_regression: 'bg-coral/15 text-[#a82e1b] border-coral/40',
  known_bug: 'bg-amber-100 text-amber-800 border-amber-300',
  flaky: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  infrastructure: 'bg-violet-100 text-violet-800 border-violet-300',
  automation_failure: 'bg-cyan/20 text-cyan-900 border-cyan/60',
  possibly_fixed: 'bg-emerald-100 text-emerald-800 border-emerald-300',
};

export function formatTime(value?: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function humanize(value?: string | null) {
  return (value ?? 'unclassified').replaceAll('_', ' ');
}
