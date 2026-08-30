import { describe, expect, it } from 'vitest';
import { buildFailureModeReport, type FailureModeSample } from '../services/failure-mode-taxonomy';
import { compareFailureModeReports } from '../services/version-comparison';

const samples = (modesList: FailureModeSample['modes'][]): FailureModeSample[] =>
  modesList.map((modes, index) => ({
    threadId: `t${index}`,
    testId: `test-${index}`,
    fingerprint: `fp-${index}`,
    modes,
  }));

describe('compareFailureModeReports', () => {
  it('reports improved when the after pass rate is higher', () => {
    const before = buildFailureModeReport(
      samples([[], ['confidence_out_of_range'], ['confidence_out_of_range']])
    );
    const after = buildFailureModeReport(samples([[], [], ['confidence_out_of_range']]));

    const comparison = compareFailureModeReports(before, after, {
      beforeLabel: 'qwen3:4b',
      afterLabel: 'llama3:8b',
    });

    expect(comparison.before.passRate).toBeCloseTo(1 / 3);
    expect(comparison.after.passRate).toBeCloseTo(2 / 3);
    expect(comparison.passRateDelta).toBeCloseTo(1 / 3);
    expect(comparison.verdict).toBe('improved');
    expect(comparison.modeDeltas.confidence_out_of_range).toBe(-1);
    expect(comparison.before.label).toBe('qwen3:4b');
    expect(comparison.after.label).toBe('llama3:8b');
  });

  it('reports regressed when the after pass rate is lower', () => {
    const before = buildFailureModeReport(samples([[], [], []]));
    const after = buildFailureModeReport(samples([[], ['ungrounded_rag'], ['ungrounded_rag']]));

    const comparison = compareFailureModeReports(before, after);

    expect(comparison.verdict).toBe('regressed');
    expect(comparison.passRateDelta).toBeLessThan(0);
    expect(comparison.modeDeltas.ungrounded_rag).toBe(2);
  });

  it('reports no_change when pass rates are equal', () => {
    const before = buildFailureModeReport(samples([[], ['unsafe_high_risk_policy']]));
    const after = buildFailureModeReport(samples([[], ['unsafe_high_risk_policy']]));

    const comparison = compareFailureModeReports(before, after);

    expect(comparison.verdict).toBe('no_change');
    expect(comparison.passRateDelta).toBe(0);
  });

  it('treats a delta within noChangeThreshold as no_change', () => {
    const before = buildFailureModeReport(samples([[], [], [], ['schema_incomplete']]));
    const after = buildFailureModeReport(samples([[], [], [], []]));

    const comparison = compareFailureModeReports(before, after, { noChangeThreshold: 0.5 });

    expect(comparison.passRateDelta).toBeCloseTo(0.25);
    expect(comparison.verdict).toBe('no_change');
  });

  it('handles an empty report without dividing by zero', () => {
    const before = buildFailureModeReport([]);
    const after = buildFailureModeReport([]);

    const comparison = compareFailureModeReports(before, after);

    expect(comparison.before.passRate).toBe(0);
    expect(comparison.after.passRate).toBe(0);
    expect(comparison.verdict).toBe('no_change');
  });
});
