import { describe, it, expect } from 'vitest';
import { loadRunbooks, parseRunbook, selectRunbooks } from '../services/soc-runbooks';

describe('SOC runbooks', () => {
  const runbooks = loadRunbooks();

  it('loads every checked-in runbook with techniques', () => {
    expect(runbooks.length).toBeGreaterThanOrEqual(7);
    for (const rb of runbooks) expect(rb.techniques.length).toBeGreaterThan(0);
  });

  it('parses title and techniques', () => {
    expect(
      parseRunbook('x.md', '# Runbook: Thing\n\nTechniques: T1000, T1001.002\n')
    ).toMatchObject({
      title: 'Thing',
      techniques: ['T1000', 'T1001.002'],
    });
  });

  it('selects by parent technique', () => {
    expect(selectRunbooks(['T1110.001'], runbooks).map((r) => r.file)).toEqual([
      'credential-brute-force.md',
    ]);
    expect(selectRunbooks(['T1486'], runbooks).map((r) => r.file)).toEqual(['ransomware.md']);
  });

  it('falls back to the generic runbook', () => {
    expect(selectRunbooks([], runbooks).map((r) => r.file)).toEqual(['generic-alert-triage.md']);
    expect(selectRunbooks(['T9999'], runbooks).map((r) => r.file)).toEqual([
      'generic-alert-triage.md',
    ]);
  });
});
