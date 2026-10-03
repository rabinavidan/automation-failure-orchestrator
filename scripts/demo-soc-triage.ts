/**
 * Demo: deterministic SOC triage — one alert per disposition.
 *
 *   internal scanner (allowlisted)        -> false_positive        close
 *   attacker IP with malicious intel      -> true_positive         escalate (P1)
 *   same attacker again                   -> duplicate             suppress
 *   synthetic login monitor (known benign)-> benign_true_positive  close
 *   unknown source, no intel hits         -> needs_investigation   investigate
 *
 * Policy: config/soc-triage-policy.json. Requires the enrichment service (mock mode).
 */
import { randomUUID } from 'crypto';

const BASE_URL = process.env.INGESTION_URL ?? 'http://localhost:3001';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'local-dev-secret';
const host = `ws-${randomUUID().slice(0, 4)}`;

interface TriageResponse {
  status: string;
  triage?: {
    disposition: string;
    recommendedAction: string;
    priority: string;
    riskScore: number;
    reasons: string[];
  };
}

async function send(label: string, src: string, user: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/alerts/splunk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
    body: JSON.stringify({
      sid: `demo-triage-${randomUUID()}`,
      search_name: 'Access - Brute Force Access Behavior Detected - Rule',
      app: 'SplunkEnterpriseSecuritySuite',
      result: {
        _time: String(Math.floor(Date.now() / 1000)),
        signature: 'Brute Force Access Behavior Detected',
        src,
        dest: host,
        user,
        urgency: 'high',
      },
    }),
  });
  const body = (await response.json()) as TriageResponse;
  const t = body.triage;
  console.log(
    `${label.padEnd(30)} ${body.status.padEnd(11)} -> ${t?.disposition.padEnd(21)} ${t?.recommendedAction.padEnd(11)} ${t?.priority} risk=${t?.riskScore}`
  );
  console.log(`  ${t?.reasons[0]}`);
}

async function main() {
  console.log('=== Demo: deterministic SOC triage ===\n');
  const attacker = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
  await send('Internal vulnerability scanner', '192.0.2.10', 'jdoe');
  await send('Known-bad attacker IP', attacker, 'jdoe');
  await send('Same attacker, repeat alert', attacker, 'jdoe');
  await send('Synthetic login monitor', '8.8.4.4', 'svc_healthcheck');
  await send('Unknown source', '8.8.8.8', `user-${randomUUID().slice(0, 4)}`);
  console.log(
    "\nAnalyst queue: curl 'http://localhost:3001/api/alerts?disposition=needs_investigation'"
  );
}

main();
