const ingestionUrl = process.env.INGESTION_URL ?? 'http://localhost:3001';
const dashboardUrl = process.env.DASHBOARD_URL ?? 'http://localhost:4173';
const secret = process.env.WEBHOOK_SECRET ?? 'local-dev-secret';

async function waitFor(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

await Promise.all([waitFor(`${ingestionUrl}/health`), waitFor(dashboardUrl)]);

const runId = `ci-smoke-${Date.now()}`;
const payload = {
  schemaVersion: '1.0.0',
  runId,
  repository: process.env.GITHUB_REPOSITORY ?? 'local/automation-failure-orchestrator',
  branch: process.env.GITHUB_REF_NAME ?? 'ci',
  commitSha: process.env.GITHUB_SHA ?? '0000000000000000000000000000000000000000',
  environment: 'ci',
  triggeredBy: 'ci-smoke',
  startedAt: new Date(Date.now() - 5_000).toISOString(),
  finishedAt: new Date().toISOString(),
  summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
  tests: [
    {
      testId: `ci/smoke::${runId}`,
      title: 'CI smoke regression reaches guarded action pipeline',
      suite: 'CI Smoke',
      file: 'scripts/ci-smoke.mjs',
      owner: 'platform-team',
      status: 'failed',
      durationMs: 25,
      retry: 0,
      error: {
        name: 'AssertionError',
        message: 'Expected smoke signal to exercise deterministic routing',
      },
      metadata: { service: 'ingestion-service', severity: 'high', tags: ['ci', 'smoke'] },
    },
  ],
};

async function postRun() {
  return fetch(`${ingestionUrl}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
    body: JSON.stringify(payload),
  });
}

const response = await postRun();
if (response.status !== 201) {
  throw new Error(`Smoke ingestion returned ${response.status}: ${await response.text()}`);
}
const result = await response.json();
if (result.processed !== 1 || result.failures?.length !== 1) {
  throw new Error(`Unexpected smoke result: ${JSON.stringify(result)}`);
}

const duplicate = await postRun();
const duplicateResult = await duplicate.json();
if (!duplicate.ok || duplicateResult.duplicateRun !== true) {
  throw new Error(`Idempotency smoke check failed: ${JSON.stringify(duplicateResult)}`);
}

// SOC track: a Splunk alert is ingested, deduplicated, and enriched by the Python service.
const alertSid = `ci-smoke-${Date.now()}`;
const splunkAlert = {
  sid: alertSid,
  search_name: 'CI Smoke - Brute Force Access Behavior Detected',
  app: 'SplunkEnterpriseSecuritySuite',
  result: {
    _time: String(Math.floor(Date.now() / 1000)),
    signature: 'Brute Force Access Behavior Detected',
    src: `203.0.113.${(Date.now() % 250) + 1}`,
    dest: `ci-smoke-${alertSid}`,
    user: 'ci-smoke',
    urgency: 'high',
  },
};

async function postAlert() {
  return fetch(`${ingestionUrl}/api/alerts/splunk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
    body: JSON.stringify(splunkAlert),
  });
}

const alertResponse = await postAlert();
const alertResult = await alertResponse.json();
if (alertResponse.status !== 201 || alertResult.status !== 'new') {
  throw new Error(`Alert ingestion smoke failed: ${JSON.stringify(alertResult)}`);
}
if (
  alertResult.enrichment?.status !== 'enriched' ||
  alertResult.enrichment.summary?.verdict !== 'malicious'
) {
  throw new Error(`Alert enrichment smoke failed: ${JSON.stringify(alertResult.enrichment)}`);
}
if (
  alertResult.triage?.disposition !== 'true_positive' ||
  alertResult.triage.recommendedAction !== 'escalate'
) {
  throw new Error(`Alert triage smoke failed: ${JSON.stringify(alertResult.triage)}`);
}
// AI is disabled in CI; the advisory investigation must report that rather than fail.
if (alertResult.investigation?.status !== 'disabled') {
  throw new Error(`Alert investigation smoke failed: ${JSON.stringify(alertResult.investigation)}`);
}
// M5: the brute-force playbook opens a ticket now and queues the IP block for approval.
const actions = alertResult.response?.actions ?? [];
const ticket = actions.find((a) => a.action === 'ticket.create');
const block = actions.find((a) => a.action === 'firewall.block_ip');
if (ticket?.status !== 'succeeded' || block?.status !== 'pending_approval') {
  throw new Error(`Response playbook smoke failed: ${JSON.stringify(alertResult.response)}`);
}
async function postJson(path, body) {
  const response = await fetch(`${ingestionUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const approval = await postJson(`/api/responses/actions/${block.id}/decision`, {
  decision: 'approved',
  reviewer: 'ci-smoke',
});
if (approval.body.status !== 'succeeded') {
  throw new Error(`Containment approval smoke failed: ${JSON.stringify(approval.body)}`);
}
const rollback = await postJson(`/api/responses/actions/${block.id}/rollback`, {
  reviewer: 'ci-smoke',
  reason: 'smoke test cleanup',
});
if (rollback.body.status !== 'rolled_back') {
  throw new Error(`Containment rollback smoke failed: ${JSON.stringify(rollback.body)}`);
}
const alertRetry = await (await postAlert()).json();
if (alertRetry.status !== 'duplicate_delivery') {
  throw new Error(`Alert idempotency smoke failed: ${JSON.stringify(alertRetry)}`);
}

const proxyHealth = await fetch(`${dashboardUrl}/api/ingestion/health`);
if (!proxyHealth.ok) throw new Error(`Dashboard ingestion proxy returned ${proxyHealth.status}`);

console.log(
  JSON.stringify({
    ok: true,
    runId,
    classification: result.failures[0].classification,
    alertEnrichment: alertResult.enrichment.summary.verdict,
    alertTriage: `${alertResult.triage.disposition}/${alertResult.triage.priority}`,
    containment: 'approved -> executed -> rolled back',
  })
);
