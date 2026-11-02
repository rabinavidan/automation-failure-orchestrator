/**
 * Imports and runs the SOC playbook in a self-hosted Shuffle (open-source SOAR)
 * through Shuffle's REST API. Zero cost; see docker-compose.shuffle.yml.
 *
 *   node scripts/shuffle-playbook.mjs setup   # wait for Shuffle, import/update the workflow
 *
 * Executing and asserting the playbook is a test: tests/backend/system/test_shuffle_playbook.py
 * (npm run shuffle:run).
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SHUFFLE_URL = process.env.SHUFFLE_URL ?? 'http://localhost:5001';
const API_KEY = process.env.SHUFFLE_APIKEY ?? '3f6d3b8e-5c1a-4f6e-9d2b-7a1c0e4b9f21';
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

/**
 * Shuffle's Orborus runs apps as Docker Swarm services on its own overlay network, where
 * Compose service names do not resolve. Playbook steps therefore call the orchestrator
 * through the ports published on the Docker host, reached via the default bridge gateway.
 */
function dockerHostUrl(port) {
  let gateway = '172.17.0.1';
  try {
    gateway =
      execFileSync(
        'docker',
        ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )
        .toString()
        .trim() || gateway;
  } catch {
    // docker CLI unavailable: keep the Linux default gateway.
  }
  return `http://${gateway}:${port}`;
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
      process.env.PLAYBOOK_ORCHESTRATOR_URL ?? dockerHostUrl(3001)
    )
    .replaceAll('{{MOCK_URL}}', process.env.PLAYBOOK_MOCK_URL ?? dockerHostUrl(3002))
    .replaceAll('{{WEBHOOK_SECRET}}', process.env.WEBHOOK_SECRET ?? 'local-dev-secret');
  const definition = JSON.parse(template);
  console.log(
    `  playbook targets ${definition.actions.map((a) => a.parameters.find((p) => p.name === 'url')?.value).join(', ')}`
  );

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

const command = process.argv[2];
const task = command === 'setup' ? setup : null;
if (!task) {
  console.error('usage: node scripts/shuffle-playbook.mjs setup');
  process.exit(2);
}
task().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
