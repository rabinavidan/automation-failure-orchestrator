/**
 * Demo: response playbooks with human approval and rollback (SOC track M5).
 *
 *   1. A brute-force alert from a known-bad IP triggers `brute-force-response`:
 *      ticket + Slack run immediately, the firewall block waits for approval.
 *   2. An analyst approves the block -> the (mock) firewall blocks the IP.
 *   3. The analyst rolls it back -> the IP is unblocked. Every step is audited.
 *
 * Requires the Docker Compose stack (mock integrations + enrichment service).
 */
import { randomUUID } from 'crypto';

const BASE_URL = process.env.INGESTION_URL ?? 'http://localhost:3001';
const MOCK_URL = process.env.MOCK_URL ?? 'http://localhost:3002';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'local-dev-secret';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  return (await response.json()) as T;
}

function post<T>(url: string, body: unknown, headers: Record<string, string> = {}) {
  return json<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

interface Action {
  id: string;
  stepId: string;
  action: string;
  target: string | null;
  status: string;
  detail?: string;
}

async function firewall(): Promise<string[]> {
  return Object.keys((await json<{ blocks: object }>(`${MOCK_URL}/firewall/blocks`)).blocks);
}

async function main() {
  console.log('=== Demo: SOC response playbook with approval and rollback ===\n');
  const attacker = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;

  const alert = await post<{ response?: { playbooks: string[]; actions: Action[] } }>(
    `${BASE_URL}/api/alerts/splunk`,
    {
      sid: `demo-response-${randomUUID()}`,
      search_name: 'Access - Brute Force Access Behavior Detected - Rule',
      app: 'SplunkEnterpriseSecuritySuite',
      result: {
        _time: String(Math.floor(Date.now() / 1000)),
        signature: 'Brute Force Access Behavior Detected',
        src: attacker,
        dest: `ws-${randomUUID().slice(0, 4)}`,
        user: 'jdoe',
        urgency: 'high',
      },
    },
    { 'x-webhook-secret': WEBHOOK_SECRET }
  );

  console.log(`Playbooks: ${alert.response?.playbooks.join(', ')}`);
  for (const a of alert.response?.actions ?? []) {
    console.log(
      `  #${a.id} ${a.stepId.padEnd(16)} ${(a.target ?? '-').padEnd(15)} ${a.status} ${a.detail ?? ''}`
    );
  }
  const block = alert.response?.actions.find((a) => a.action === 'firewall.block_ip');
  if (!block) throw new Error('expected a firewall block action');

  console.log(`\nFirewall before approval: ${JSON.stringify(await firewall())}`);
  const approved = await post(`${BASE_URL}/api/responses/actions/${block.id}/decision`, {
    decision: 'approved',
    reviewer: 'alice',
    comment: 'Attacker confirmed by threat intel',
  });
  console.log(`Approve #${block.id}: ${JSON.stringify(approved)}`);
  console.log(`Firewall after approval:  ${JSON.stringify(await firewall())}`);

  const rolledBack = await post(`${BASE_URL}/api/responses/actions/${block.id}/rollback`, {
    reviewer: 'alice',
    reason: 'Demo cleanup',
  });
  console.log(`Rollback #${block.id}: ${JSON.stringify(rolledBack)}`);
  console.log(`Firewall after rollback:  ${JSON.stringify(await firewall())}`);

  const audit = await json<{ events: Array<{ event: string; actor: string }> }>(
    `${BASE_URL}/api/responses/actions/${block.id}`
  );
  console.log('\nAudit trail:');
  for (const e of audit.events) console.log(`  ${e.event.padEnd(12)} ${e.actor}`);
}

main();
