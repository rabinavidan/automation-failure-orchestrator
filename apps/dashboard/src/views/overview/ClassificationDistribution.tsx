import type { FailureRow as Failure } from '@orchestrator/shared-types';
import { BarChart3 } from 'lucide-react';
import { classificationColor, humanize } from '../../ui/format';

export function ClassificationDistribution({ failures }: { failures: Failure[] }) {
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
          <p className="mt-1 text-xs text-slate-600">Classification mix by unique fingerprint</p>
        </div>
        <BarChart3 size={19} className="text-slate-400" />
      </div>
      {counts.length === 0 ? (
        <p className="mt-6 text-sm text-slate-600">No classified signals yet.</p>
      ) : (
        <div className="mt-6 space-y-4">
          {counts.map(([classification, count]) => (
            <div key={classification}>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="font-semibold capitalize">{humanize(classification)}</span>
                <span className="font-mono text-[10px] text-slate-600">
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
