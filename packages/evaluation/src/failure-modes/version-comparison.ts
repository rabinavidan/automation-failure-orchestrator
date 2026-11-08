import type { FailureMode, FailureModeReport } from './failure-mode-taxonomy';

export interface VersionSummary {
  label: string;
  sampleSize: number;
  cleanCount: number;
  passRate: number;
}

export type VersionVerdict = 'improved' | 'regressed' | 'no_change';

export interface VersionComparison {
  before: VersionSummary;
  after: VersionSummary;
  passRateDelta: number;
  verdict: VersionVerdict;
  modeDeltas: Record<FailureMode, number>;
}

function passRate(report: FailureModeReport): number {
  return report.sampleSize === 0 ? 0 : report.cleanCount / report.sampleSize;
}

export function compareFailureModeReports(
  before: FailureModeReport,
  after: FailureModeReport,
  options: { beforeLabel?: string; afterLabel?: string; noChangeThreshold?: number } = {}
): VersionComparison {
  const threshold = options.noChangeThreshold ?? 0;
  const beforeRate = passRate(before);
  const afterRate = passRate(after);
  const passRateDelta = afterRate - beforeRate;

  const modeDeltas = Object.fromEntries(
    (Object.keys(before.modeCounts) as FailureMode[]).map((mode) => [
      mode,
      after.modeCounts[mode] - before.modeCounts[mode],
    ])
  ) as Record<FailureMode, number>;

  const verdict: VersionVerdict =
    passRateDelta > threshold ? 'improved' : passRateDelta < -threshold ? 'regressed' : 'no_change';

  return {
    before: {
      label: options.beforeLabel ?? 'before',
      sampleSize: before.sampleSize,
      cleanCount: before.cleanCount,
      passRate: beforeRate,
    },
    after: {
      label: options.afterLabel ?? 'after',
      sampleSize: after.sampleSize,
      cleanCount: after.cleanCount,
      passRate: afterRate,
    },
    passRateDelta,
    verdict,
    modeDeltas,
  };
}
