import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { sentinelBruteForce, wazuhSshBruteForce } from './fixtures/siem-alerts';
import { splunkBruteForceAlert } from './fixtures/splunk-alerts';

interface N8nNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
}
interface Workflow {
  id: string;
  nodes: N8nNode[];
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

const workflow = JSON.parse(
  readFileSync(join(__dirname, '../../../../n8n/workflows/soc-alert-workflow.json'), 'utf-8')
) as Workflow;
const byName = (name: string) => workflow.nodes.find((n) => n.name === name)!;

/** Runs an n8n Code node's JavaScript with a minimal `$input` shim. */
function runCodeNode(name: string, input: unknown) {
  const code = byName(name).parameters.jsCode as string;
  const $input = { first: () => ({ json: input }) };
  return new Function('$input', code)($input) as Array<{ json: Record<string, unknown> }>;
}

describe('n8n SOC workflow (multi-SIEM front door)', () => {
  it('is structurally valid: unique names and every connection target exists', () => {
    const names = workflow.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [from, { main }] of Object.entries(workflow.connections)) {
      expect(names).toContain(from);
      for (const output of main) for (const edge of output) expect(names).toContain(edge.node);
    }
    expect(byName('Receive SIEM Alert').parameters).toMatchObject({
      httpMethod: 'POST',
      path: 'soc-alerts',
      responseMode: 'responseNode',
    });
  });

  it('authenticates to the ingestion vendor endpoint with the shared secret', () => {
    const ingest = byName('Ingest via Orchestrator').parameters;
    expect(ingest.url).toBe('=http://ingestion-service:3001/api/alerts/{{ $json.vendor }}');
    expect(JSON.stringify(ingest.headerParameters)).toContain('x-webhook-secret');
  });

  it('switch outputs line up with its rules plus the fallback', () => {
    const rules = (byName('Route by Triage Disposition').parameters.rules as { values: unknown[] })
      .values;
    expect(workflow.connections['Route by Triage Disposition']!.main).toHaveLength(
      rules.length + 1
    );
  });

  it.each([
    ['splunk', splunkBruteForceAlert],
    ['sentinel', sentinelBruteForce],
    ['wazuh', wazuhSshBruteForce],
  ])('detects %s payloads (raw body and n8n `body` wrapper)', (vendor, payload) => {
    expect(runCodeNode('Detect SIEM Vendor', payload)[0]!.json.vendor).toBe(vendor);
    expect(runCodeNode('Detect SIEM Vendor', { body: payload })[0]!.json).toEqual({
      vendor,
      payload,
    });
  });

  it('rejects unknown payloads instead of guessing', () => {
    expect(() => runCodeNode('Detect SIEM Vendor', { hello: 'world' })).toThrow(/Unrecognized/);
  });

  it('builds a ChatOps approval request listing pending containment', () => {
    const [out] = runCodeNode('Summarize Pending Containment', {
      alertId: 'splunk:x',
      triage: { priority: 'P1', reasons: ['Threat intel: ip 203.0.113.9 is malicious'] },
      response: {
        actions: [
          { id: '1', action: 'ticket.create', status: 'succeeded', target: null },
          {
            id: '3',
            action: 'firewall.block_ip',
            status: 'pending_approval',
            target: '203.0.113.9',
          },
        ],
      },
    });
    expect(out!.json._pendingCount).toBe(1);
    expect(out!.json._approvalText).toContain('#3 *firewall.block_ip*');
    expect(out!.json._approvalText).toContain('/api/responses/actions/3/decision');
  });

  it('delegates decisions to the service: no triage or policy logic in Code nodes', () => {
    const code = workflow.nodes
      .filter((n) => n.type === 'n8n-nodes-base.code')
      .map((n) => n.parameters.jsCode as string)
      .join('\n');
    for (const forbidden of ['allowlist', 'riskScore =', 'disposition =', 'fingerprint']) {
      expect(code).not.toContain(forbidden);
    }
  });
});
