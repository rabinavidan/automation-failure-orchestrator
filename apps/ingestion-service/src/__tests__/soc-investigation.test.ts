import { describe, it, expect } from 'vitest';
import type { InvestigationModel } from '../services/failure-investigation-agent';
import { applyGuardrails, runSocInvestigation } from '../services/soc-investigation';
import { loadRunbooks, selectRunbooks } from '../services/soc-runbooks';
import { socAlert, socEnrichment, socTriage, scriptedResponses } from './fixtures/soc-alert';

function scriptedClient(contents: string[]) {
  const prompts: Array<Array<{ role: string; content: string }>> = [];
  const client: InvestigationModel = {
    async chat(input) {
      prompts.push(input.messages as Array<{ role: string; content: string }>);
      return {
        message: { role: 'assistant', content: contents.shift()! },
        prompt_eval_count: 100,
        eval_count: 30,
      };
    },
  };
  return { client, prompts };
}

const runbooks = selectRunbooks(socTriage.mitre.techniques, loadRunbooks());

describe('SOC multi-agent investigation', () => {
  it('runs triage analyst -> threat intel -> response planner -> supervisor -> guardrails', async () => {
    const { client, prompts } = scriptedClient(scriptedResponses());
    const events: string[] = [];
    const metrics: string[] = [];

    const result = await runSocInvestigation(
      { alert: socAlert, triage: socTriage, enrichment: socEnrichment, runbooks },
      client,
      'qwen-test',
      {
        audit: {
          async record(e) {
            if (e.status === 'completed') events.push(e.node);
          },
        },
        telemetry: {
          async recordModelCall(m) {
            metrics.push(m.promptVersion);
          },
        },
      }
    );

    expect(events).toEqual([
      'agent:triage_analyst',
      'agent:threat_intel',
      'agent:response_planner',
      'supervisor',
      'guardrails',
    ]);
    expect(metrics).toEqual([
      'soc-triage-analyst-v1',
      'soc-threat-intel-v1',
      'soc-response-planner-v1',
      'soc-supervisor-v1',
    ]);
    expect(result?.specialistReports.map((r) => r.agent)).toEqual([
      'triage_analyst',
      'threat_intel',
      'response_planner',
    ]);
    // Code, not the model, sets the approval requirement for containment.
    expect(result).toMatchObject({
      recommendedResponse: 'contain',
      requiresHumanApproval: true,
      conflictsWithTriage: false,
      graphVersion: 'soc-supervisor-v1',
      model: 'qwen-test',
    });
    expect(prompts).toHaveLength(4);
  });

  it('treats alert fields as untrusted data and never sends the raw SIEM payload', async () => {
    const { client, prompts } = scriptedClient(scriptedResponses());
    await runSocInvestigation(
      { alert: socAlert, triage: socTriage, enrichment: socEnrichment, runbooks },
      client,
      'm'
    );
    for (const messages of prompts) {
      expect(messages[0]!.content).toContain('untrusted data');
      expect(messages[1]!.content).not.toContain('raw SIEM payload');
    }
  });

  it('gives the planner only the selected runbooks', async () => {
    const { client, prompts } = scriptedClient(scriptedResponses());
    await runSocInvestigation(
      { alert: socAlert, triage: socTriage, enrichment: null, runbooks },
      client,
      'm'
    );
    const plannerPayload = JSON.parse(prompts[2]![1]!.content);
    expect(plannerPayload.runbooks.map((r: { file: string }) => r.file)).toEqual([
      'credential-brute-force.md',
    ]);
    const intelPayload = JSON.parse(prompts[1]![1]!.content);
    expect(intelPayload.enrichment).toEqual({ available: false });
  });

  it('rejects schema-invalid model output', async () => {
    const { client } = scriptedClient(['{"summary": ""}']);
    await expect(
      runSocInvestigation(
        { alert: socAlert, triage: socTriage, enrichment: socEnrichment, runbooks },
        client,
        'm'
      )
    ).rejects.toThrow();
  });
});

describe('applyGuardrails', () => {
  const triage = (recommendedAction: typeof socTriage.recommendedAction) => ({
    ...socTriage,
    recommendedAction,
  });

  it.each([
    // [deterministic action, AI recommendation, planner risk, approval, conflict]
    ['escalate', 'contain', 'medium', true, false],
    ['escalate', 'investigate', 'low', false, false],
    ['escalate', 'close', 'low', true, true],
    ['escalate', 'monitor', 'low', true, true],
    ['investigate', 'close', 'low', true, true],
    ['investigate', 'monitor', 'low', false, false],
    ['investigate', 'investigate', 'high', true, false],
    ['close', 'contain', 'low', true, true],
  ] as const)(
    'triage %s + AI %s (risk %s) -> approval %s, conflict %s',
    (action, recommended, risk, approval, conflict) => {
      expect(applyGuardrails(recommended, triage(action), risk)).toEqual({
        requiresHumanApproval: approval,
        conflictsWithTriage: conflict,
      });
    }
  );
});
