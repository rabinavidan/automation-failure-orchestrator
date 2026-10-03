/**
 * Demo: SOC brute-force alert deduplication (Splunk webhook)
 * 1. First brute-force alert             -> new (actionable)
 * 2. Splunk retries the same webhook     -> duplicate_delivery (no-op)
 * 3. Same attacker/host/user, 10 min later, different user spelling -> suppressed
 * 4. Different attacker IP               -> new (separate fingerprint)
 */
import { randomUUID } from 'crypto';
import { sendSplunkAlert } from './demo-helpers';

// Unique per demo run so repeated runs start from a clean fingerprint.
const attacker = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
const host = `ws-${randomUUID().slice(0, 4)}.corp.example.com`;

function bruteForceAlert(opts: { minutesAgo: number; src: string; user: string; sid: string }) {
  return {
    sid: opts.sid,
    search_name: 'Access - Brute Force Access Behavior Detected - Rule',
    app: 'SplunkEnterpriseSecuritySuite',
    owner: 'admin',
    results_link: 'https://splunk.example.com/app/SplunkEnterpriseSecuritySuite/search',
    result: {
      _time: String(Math.floor(Date.now() / 1000) - opts.minutesAgo * 60),
      signature: 'Brute Force Access Behavior Detected',
      src: opts.src,
      dest: host,
      user: opts.user,
      count: '57',
      urgency: 'high',
      mitre_tactic: 'Credential Access',
      'annotations.mitre_attack': ['T1110', 'T1110.001'],
    },
  };
}

async function main() {
  console.log('=== Demo: SOC brute-force alert deduplication ===\n');

  const first = bruteForceAlert({
    minutesAgo: 10,
    src: attacker,
    user: 'CORP\\jdoe',
    sid: 'sid-1',
  });

  console.log('--- 1. First alert (expected: new) ---');
  await sendSplunkAlert(first);

  console.log('\n--- 2. Splunk webhook retry (expected: duplicate_delivery) ---');
  await sendSplunkAlert(first);

  console.log('\n--- 3. Same detection 10 min later, UPN user spelling (expected: suppressed) ---');
  await sendSplunkAlert(
    bruteForceAlert({ minutesAgo: 0, src: attacker, user: 'jdoe@corp.example.com', sid: 'sid-2' })
  );

  console.log('\n--- 4. Different attacker IP (expected: new) ---');
  await sendSplunkAlert(
    bruteForceAlert({ minutesAgo: 0, src: '198.51.100.23', user: 'CORP\\jdoe', sid: 'sid-3' })
  );
}

main();
