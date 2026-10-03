import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { PlaybookSchema } from '@orchestrator/shared-types';
import { loadPlaybooks, playbookMatches, selectPlaybooks } from '../services/playbooks';
import { socTriage } from './fixtures/soc-alert';

const checkedIn = loadPlaybooks();

describe('checked-in playbooks', () => {
  it('all load without errors', () => {
    expect(checkedIn.errors).toEqual([]);
    expect(checkedIn.playbooks.map((p) => p.id).sort()).toEqual([
      'analyst-queue',
      'brute-force-response',
      'critical-compromise',
      'malware-containment',
    ]);
  });

  it('every containment step requires approval', () => {
    for (const playbook of checkedIn.playbooks) {
      for (const step of playbook.steps) {
        if (step.action.startsWith('firewall.') || step.action.startsWith('edr.')) {
          expect(step.approval, `${playbook.id}/${step.id}`).toBe('required');
        }
      }
    }
  });
});

describe('PlaybookSchema safety rules', () => {
  const base = {
    id: 'x',
    version: 1,
    description: 'd',
    owner: 'o',
    trigger: { dispositions: ['true_positive'] },
  };

  it('rejects auto-executed containment', () => {
    const result = PlaybookSchema.safeParse({
      ...base,
      steps: [
        {
          id: 'iso',
          action: 'edr.isolate_host',
          description: 'd',
          target: { indicator: 'host' },
          approval: 'none',
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('approval: required');
  });

  it('rejects containment without a target and unknown actions', () => {
    expect(
      PlaybookSchema.safeParse({
        ...base,
        steps: [{ id: 'b', action: 'firewall.block_ip', description: 'd', approval: 'required' }],
      }).success
    ).toBe(false);
    expect(
      PlaybookSchema.safeParse({
        ...base,
        steps: [{ id: 'r', action: 'shell.exec', description: 'd', approval: 'required' }],
      }).success
    ).toBe(false);
  });
});

describe('loadPlaybooks', () => {
  it('excludes invalid files and duplicate ids instead of partially loading them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-'));
    const valid = `id: a\nversion: 1\ndescription: d\nowner: o\ntrigger: { dispositions: [true_positive] }\nsteps:\n  - { id: t, action: ticket.create, description: d, approval: none }\n`;
    writeFileSync(join(dir, '1.yaml'), valid);
    writeFileSync(join(dir, '2.yaml'), valid);
    writeFileSync(join(dir, '3.yaml'), 'id: [unclosed');
    writeFileSync(
      join(dir, '4.yml'),
      valid.replace('id: a', 'id: b').replace('ticket.create', 'edr.isolate_host')
    );
    const result = loadPlaybooks(dir);
    expect(result.playbooks.map((p) => p.id)).toEqual(['a']);
    expect(result.errors.map((e) => e.file)).toEqual(['2.yaml', '3.yaml', '4.yml']);
  });
});

describe('playbook selection', () => {
  const byId = (id: string) => checkedIn.playbooks.find((p) => p.id === id)!;

  it('matches disposition and ATT&CK technique (parent match)', () => {
    expect(selectPlaybooks(checkedIn.playbooks, socTriage).map((p) => p.id)).toEqual([
      'brute-force-response',
    ]);
    const malware = { ...socTriage, mitre: { ...socTriage.mitre, techniques: ['T1204.002'] } };
    expect(selectPlaybooks(checkedIn.playbooks, malware).map((p) => p.id)).toEqual([
      'malware-containment',
    ]);
  });

  it('respects maxPriority', () => {
    const queue = byId('analyst-queue');
    const triage = { ...socTriage, disposition: 'needs_investigation' as const };
    expect(playbookMatches(queue, { ...triage, priority: 'P2' })).toBe(true);
    expect(playbookMatches(queue, { ...triage, priority: 'P3' })).toBe(false);
  });

  it('never runs containment playbooks for closed dispositions', () => {
    for (const disposition of ['false_positive', 'duplicate', 'benign_true_positive'] as const) {
      expect(selectPlaybooks(checkedIn.playbooks, { ...socTriage, disposition })).toEqual([]);
    }
  });
});
