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

const proxyHealth = await fetch(`${dashboardUrl}/api/ingestion/health`);
if (!proxyHealth.ok) throw new Error(`Dashboard ingestion proxy returned ${proxyHealth.status}`);

console.log(JSON.stringify({ ok: true, runId, classification: result.failures[0].classification }));
