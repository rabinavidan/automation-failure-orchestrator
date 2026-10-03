import express from 'express';

const app = express();
app.use(express.json());

// ---- In-memory stores ----
interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: string;
    status: { name: string };
    labels: string[];
    [key: string]: unknown;
  };
  comments: Array<{ body: string; created: string }>;
  created: string;
}

const jiraIssues = new Map<string, JiraIssue>();
let jiraCounter = 0;

const slackMessages: Array<{
  id: string;
  channel: string;
  payload: unknown;
  receivedAt: string;
}> = [];
let slackCounter = 0;

// ---- Request logger ----
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---- JIRA ENDPOINTS ----

// Create issue
app.post('/jira/rest/api/2/issue', (req, res) => {
  jiraCounter++;
  const key = `MOCK-${jiraCounter}`;
  const body = req.body as {
    fields?: {
      summary?: string;
      description?: string;
      labels?: string[];
    };
  };

  const issue: JiraIssue = {
    key,
    fields: {
      summary: body.fields?.summary ?? 'No summary',
      description: body.fields?.description,
      status: { name: 'Open' },
      labels: body.fields?.labels ?? [],
      ...body.fields,
    },
    comments: [],
    created: new Date().toISOString(),
  };

  jiraIssues.set(key, issue);
  console.log(`  [Jira] Created issue ${key}: ${issue.fields.summary}`);
  res.status(201).json({ id: String(jiraCounter), key, self: `/jira/rest/api/2/issue/${key}` });
});

// Search issues by JQL
app.get('/jira/rest/api/2/search', (req, res) => {
  const jql = String(req.query.jql ?? '');
  console.log(`  [Jira] Search JQL: ${jql}`);

  const allIssues = Array.from(jiraIssues.values());

  // Simple JQL parsing: support label matching
  let filtered = allIssues;
  const labelMatch = jql.match(/labels\s*=\s*"?([^"\s]+)"?/i);
  if (labelMatch) {
    const labelToFind = labelMatch[1];
    filtered = allIssues.filter((issue) => issue.fields.labels.includes(labelToFind));
  }

  const summaryMatch = jql.match(/summary\s*~\s*"?([^"]+)"?/i);
  if (summaryMatch) {
    const term = summaryMatch[1].toLowerCase();
    filtered = allIssues.filter((issue) => issue.fields.summary.toLowerCase().includes(term));
  }

  res.json({
    total: filtered.length,
    issues: filtered.map((issue) => ({
      id: issue.key,
      key: issue.key,
      fields: issue.fields,
    })),
  });
});

// Get single issue
app.get('/jira/rest/api/2/issue/:key', (req, res) => {
  const issue = jiraIssues.get(req.params.key);
  if (!issue) {
    res.status(404).json({ error: 'Issue not found' });
    return;
  }
  res.json({ key: issue.key, fields: issue.fields });
});

// Add comment to issue
app.post('/jira/rest/api/2/issue/:key/comment', (req, res) => {
  const issue = jiraIssues.get(req.params.key);
  if (!issue) {
    res.status(404).json({ error: 'Issue not found' });
    return;
  }

  const body = req.body as { body?: string };
  const comment = {
    body: body.body ?? '',
    created: new Date().toISOString(),
  };

  issue.comments.push(comment);
  console.log(`  [Jira] Comment on ${req.params.key}: ${comment.body.slice(0, 80)}`);

  res.status(201).json({
    id: String(issue.comments.length),
    body: comment.body,
    created: comment.created,
  });
});

// View all mock issues (UI/debug)
app.get('/jira/issues', (_req, res) => {
  const issues = Array.from(jiraIssues.values());
  res.json({ count: issues.length, issues });
});

// ---- SLACK ENDPOINTS ----

// Receive Slack messages (incoming webhook style)
app.post('/slack/services/:team/:bot/:token', (req, res) => {
  slackCounter++;
  const message = {
    id: String(slackCounter),
    channel: `${req.params.team}/${req.params.bot}/${req.params.token}`,
    payload: req.body,
    receivedAt: new Date().toISOString(),
  };

  slackMessages.push(message);
  const text =
    typeof req.body === 'object' && req.body !== null
      ? ((req.body as Record<string, unknown>).text ?? JSON.stringify(req.body).slice(0, 80))
      : String(req.body).slice(0, 80);
  console.log(`  [Slack] Message #${slackCounter}: ${text}`);

  res.json({ ok: true, ts: String(Date.now() / 1000) });
});

// View all Slack messages (UI/debug)
app.get('/slack/messages', (_req, res) => {
  res.json({ count: slackMessages.length, messages: slackMessages });
});

// ---- EDR + FIREWALL ENDPOINTS (SOC response actions) ----
// Modeled loosely on EDR "contain host" / "kill process" APIs and a firewall block list.

interface EdrAction {
  id: string;
  type: 'isolate' | 'release' | 'kill_process';
  host: string;
  process?: string;
  requestedBy?: string;
  at: string;
}

const isolatedHosts = new Map<string, { since: string; reason?: string }>();
const edrActions: EdrAction[] = [];
const firewallBlocks = new Map<string, { since: string; reason?: string }>();
let edrCounter = 0;

function recordEdr(action: Omit<EdrAction, 'id' | 'at'>): EdrAction {
  edrCounter++;
  const entry = { ...action, id: `edr-${edrCounter}`, at: new Date().toISOString() };
  edrActions.push(entry);
  return entry;
}

app.post('/edr/hosts/:host/isolate', (req, res) => {
  const host = req.params.host.toLowerCase();
  const alreadyIsolated = isolatedHosts.has(host);
  isolatedHosts.set(host, { since: new Date().toISOString(), reason: req.body?.reason });
  const action = recordEdr({ type: 'isolate', host, requestedBy: req.body?.requestedBy });
  console.log(`  [EDR] Isolated ${host}`);
  res.status(alreadyIsolated ? 200 : 201).json({ ok: true, host, isolated: true, action });
});

app.post('/edr/hosts/:host/release', (req, res) => {
  const host = req.params.host.toLowerCase();
  if (!isolatedHosts.delete(host)) {
    res.status(404).json({ ok: false, error: 'host is not isolated' });
    return;
  }
  const action = recordEdr({ type: 'release', host, requestedBy: req.body?.requestedBy });
  console.log(`  [EDR] Released ${host}`);
  res.json({ ok: true, host, isolated: false, action });
});

app.post('/edr/processes/kill', (req, res) => {
  const { host, process: processName, requestedBy } = req.body ?? {};
  if (typeof host !== 'string' || typeof processName !== 'string') {
    res.status(400).json({ ok: false, error: 'host and process are required' });
    return;
  }
  const action = recordEdr({
    type: 'kill_process',
    host: host.toLowerCase(),
    process: processName,
    requestedBy,
  });
  console.log(`  [EDR] Killed ${processName} on ${host}`);
  res.status(201).json({ ok: true, action });
});

app.get('/edr/hosts', (_req, res) => {
  res.json({ isolated: Object.fromEntries(isolatedHosts) });
});

app.get('/edr/actions', (_req, res) => {
  res.json({ count: edrActions.length, actions: edrActions });
});

app.post('/firewall/blocks', (req, res) => {
  const ip = req.body?.ip;
  if (typeof ip !== 'string' || ip.length === 0) {
    res.status(400).json({ ok: false, error: 'ip is required' });
    return;
  }
  const existed = firewallBlocks.has(ip);
  firewallBlocks.set(ip, { since: new Date().toISOString(), reason: req.body?.reason });
  console.log(`  [Firewall] Blocked ${ip}`);
  res.status(existed ? 200 : 201).json({ ok: true, ip, blocked: true });
});

app.delete('/firewall/blocks/:ip', (req, res) => {
  if (!firewallBlocks.delete(req.params.ip)) {
    res.status(404).json({ ok: false, error: 'ip is not blocked' });
    return;
  }
  console.log(`  [Firewall] Unblocked ${req.params.ip}`);
  res.json({ ok: true, ip: req.params.ip, blocked: false });
});

app.get('/firewall/blocks', (_req, res) => {
  res.json({ count: firewallBlocks.size, blocks: Object.fromEntries(firewallBlocks) });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    jiraIssues: jiraIssues.size,
    slackMessages: slackMessages.length,
    isolatedHosts: isolatedHosts.size,
    firewallBlocks: firewallBlocks.size,
  });
});

// Reset state (for testing)
app.post('/reset', (_req, res) => {
  jiraIssues.clear();
  slackMessages.length = 0;
  jiraCounter = 0;
  slackCounter = 0;
  isolatedHosts.clear();
  edrActions.length = 0;
  firewallBlocks.clear();
  edrCounter = 0;
  res.json({ ok: true });
});

const PORT = parseInt(process.env.MOCK_PORT ?? '3002', 10);
app.listen(PORT, () => {
  console.log(`Mock integrations server running on port ${PORT}`);
  console.log(`  Jira: http://localhost:${PORT}/jira/rest/api/2/`);
  console.log(`  Slack: http://localhost:${PORT}/slack/services/T00/B00/xxx`);
  console.log(`  View issues: http://localhost:${PORT}/jira/issues`);
  console.log(`  View messages: http://localhost:${PORT}/slack/messages`);
  console.log(
    `  EDR: http://localhost:${PORT}/edr/hosts  Firewall: http://localhost:${PORT}/firewall/blocks`
  );
});

export default app;
