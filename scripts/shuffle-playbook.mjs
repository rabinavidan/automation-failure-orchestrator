/**
 * Imports and runs the SOC playbook in a self-hosted Shuffle (open-source SOAR)
 * through Shuffle's REST API. Zero cost; see docker-compose.shuffle.yml.
 *
 *   node scripts/shuffle-playbook.mjs setup   # wait for Shuffle, import/update the workflow
 *   node scripts/shuffle-playbook.mjs run     # execute with a Splunk alert, assert the result
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const SHUFFLE_URL = process.env.SHUFFLE_URL ?? 'http://localhost:5001';
const API_KEY = process.env.SHUFFLE_APIKEY ?? '3f6d3b8e-5c1a-4f6e-9d2b-7a1c0e4b9f21';
const MOCK_HOST_URL = process.env.MOCK_URL ?? 'http://localhost:3002';
const TEMPLATE = new URL('../shuffle/soc-alert-playbook.json', import.meta.url);
const WORKFLOW_NAME = 'SOC Alert Triage (Orchestrator)';

const auth = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

async function api(method, path, body) {
  const response = await fetch(`${SHUFFLE_URL}${path}`, {
    method,
    headers: auth,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!response.ok)
    throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return json;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, check, timeoutMs = 600_000, everyMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(everyMs);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? ` (last error: ${lastError})` : ''}`
  );
}

async function findHttpApp() {
  const apps = await api('GET', '/api/v1/apps');
  const list = Array.isArray(apps) ? apps : (apps.apps ?? []);
  return list.find((a) => String(a.name).toLowerCase() === 'http' && a.app_version === '1.4.0');
}

async function findWorkflow() {
  const workflows = await api('GET', '/api/v1/workflows');
  return (Array.isArray(workflows) ? workflows : []).find((w) => w.name === WORKFLOW_NAME);
}

async function setup() {
  console.log(
    `Waiting for Shuffle at ${SHUFFLE_URL} and its HTTP app (first start downloads apps)...`
  );
  const httpApp = await waitFor('Shuffle http 1.4.0 app', findHttpApp);
  console.log(`  http app ${httpApp.app_version} id=${httpApp.id}`);

  const template = readFileSync(TEMPLATE, 'utf-8')
    .replaceAll('{{HTTP_APP_ID}}', httpApp.id)
    .replaceAll(
      '{{ORCHESTRATOR_URL}}',
      process.env.PLAYBOOK_ORCHESTRATOR_URL ?? 'http://ingestion-service:3001'
    )
    .replaceAll('{{MOCK_URL}}', process.env.PLAYBOOK_MOCK_URL ?? 'http://mock-integrations:3002')
    .replaceAll('{{WEBHOOK_SECRET}}', process.env.WEBHOOK_SECRET ?? 'local-dev-secret');
  const definition = JSON.parse(template);

  let workflow = await findWorkflow();
  if (!workflow) {
    workflow = await api('POST', '/api/v1/workflows', {
      name: definition.name,
      description: definition.description,
    });
    console.log(`  created workflow ${workflow.id}`);
  } else {
    console.log(`  updating existing workflow ${workflow.id}`);
  }

  const saved = await api('PUT', `/api/v1/workflows/${workflow.id}`, {
    ...workflow,
    ...definition,
    id: workflow.id,
  });
  console.log(`  saved: ${JSON.stringify(saved).slice(0, 160)}`);
  console.log(`\nOpen http://localhost:3080 and look for "${WORKFLOW_NAME}".`);
}

async function run() {
  const workflow = await findWorkflow();
  if (!workflow) throw new Error('workflow not found; run `npm run shuffle:setup` first');

  const attacker = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
  const splunkAlert = {
    sid: `shuffle-${randomUUID()}`,
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
  };

  const started = await api('POST', `/api/v1/workflows/${workflow.id}/execute`, {
    execution_argument: JSON.stringify(splunkAlert),
    start: '',
  });
  console.log(`Execution ${started.execution_id} started (attacker ${attacker})`);

  const execution = await waitFor(
    'execution to finish',
    async () => {
      const result = await api('POST', '/api/v1/streams/results', {
        execution_id: started.execution_id,
        authorization: started.authorization,
      });
      return ['FINISHED', 'ABORTED', 'FAILURE'].includes(result.status) ? result : null;
    },
    300_000,
    3_000
  );

  console.log(`Execution status: ${execution.status}`);
  const byLabel = {};
  for (const r of execution.results ?? []) {
    byLabel[r.action?.label] = r;
    console.log(`  [${r.status}] ${r.action?.label}: ${String(r.result).slice(0, 220)}`);
  }

  const ingest = JSON.parse(byLabel.ingest?.result ?? '{}');
  const triage = ingest.body?.triage;
  const ok =
    execution.status === 'FINISHED' &&
    byLabel.ingest?.status === 'SUCCESS' &&
    ingest.status === 201 &&
    triage?.disposition === 'true_positive' &&
    byLabel.notify?.status === 'SUCCESS';
  if (!ok) throw new Error('playbook did not complete as expected');

  const messages = await (await fetch(`${MOCK_HOST_URL}/slack/messages`)).json();
  const posted = (messages.messages ?? []).find((m) =>
    String(m.payload?.text ?? '').includes(`[Shuffle SOAR] ${triage.priority} true_positive`)
  );
  if (!posted) throw new Error('ChatOps message from Shuffle not found in mock Slack');
  console.log(`\nChatOps message: ${posted.payload.text}`);
  console.log('✓ Shuffle SOAR playbook verified end to end.');
}

const command = process.argv[2];
const task = command === 'setup' ? setup : command === 'run' ? run : null;
if (!task) {
  console.error('usage: node scripts/shuffle-playbook.mjs <setup|run>');
  process.exit(2);
}
task().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
