/**
 * Demo: one pipeline, three SIEMs (SOC track M6).
 *
 * The same credential-access attack pattern arrives as a Splunk webhook, a
 * Microsoft Sentinel alert and a Wazuh alert. Each native payload is normalized
 * onto the SecurityAlert contract, then enriched, triaged and answered by the
 * same deterministic pipeline and playbooks.
 *
 * Set N8N=true to send through the n8n SOC workflow (/webhook/soc-alerts) instead.
 */
import { randomUUID } from 'crypto';

const BASE_URL = process.env.INGESTION_URL ?? 'http://localhost:3001';
const N8N_URL = process.env.N8N_URL ?? 'http://localhost:5678';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'local-dev-secret';
const viaN8n = process.env.N8N === 'true';
const now = new Date().toISOString();
const octet = () => Math.floor(Math.random() * 254) + 1;

const payloads: Record<string, unknown> = {
  splunk: {
    sid: `demo-${randomUUID()}`,
    search_name: 'Access - Brute Force Access Behavior Detected - Rule',
    app: 'SplunkEnterpriseSecuritySuite',
    result: {
      _time: String(Math.floor(Date.now() / 1000)),
      signature: 'Brute Force Access Behavior Detected',
      src: `203.0.113.${octet()}`,
      dest: 'ws-042',
      user: 'jdoe',
      urgency: 'high',
    },
  },
  sentinel: {
    SystemAlertId: randomUUID(),
    AlertDisplayName: 'Brute force attack against Azure AD account',
    Severity: 'High',
    StartTimeUtc: now,
    Tactics: 'CredentialAccess',
    Techniques: '["T1110.003"]',
    Entities: JSON.stringify([
      { Type: 'account', Name: 'jdoe', UPNSuffix: 'corp.example.com' },
      { Type: 'ip', Address: `203.0.113.${octet()}` },
    ]),
  },
  wazuh: {
    id: `${Date.now() / 1000}`,
    timestamp: now,
    rule: {
      id: '5712',
      level: 10,
      description: 'sshd: brute force trying to get access to the system. Non existent user.',
      mitre: { id: ['T1110'], tactic: ['Credential Access'] },
    },
    agent: { name: 'web-01' },
    data: { srcip: `203.0.113.${octet()}`, dstuser: 'root' },
  },
};

interface Result {
  status?: string;
  disposition?: string | null;
  triage?: { disposition: string; priority: string; mitre: { techniques: string[] } };
  response?: { playbooks: string[] };
}

async function main() {
  console.log(`=== Demo: multi-SIEM ingestion${viaN8n ? ' via n8n' : ''} ===\n`);
  for (const [vendor, payload] of Object.entries(payloads)) {
    const url = viaN8n ? `${N8N_URL}/webhook/soc-alerts` : `${BASE_URL}/api/alerts/${vendor}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as Result;
    const t = body.triage;
    console.log(
      `${vendor.padEnd(9)} HTTP ${response.status}  ${body.status ?? ''}  ->  ${t?.disposition ?? body.disposition}  ${t?.priority ?? ''}  ATT&CK ${t?.mitre.techniques.join(',') ?? ''}  playbooks: ${body.response?.playbooks.join(', ') ?? '-'}`
    );
  }
}

main();
