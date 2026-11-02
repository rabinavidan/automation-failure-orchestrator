/**
 * Deterministic Ollama-protocol stub for zero-cost demos and CI (no GPU, no model).
 *
 * It answers POST /api/chat with a JSON object synthesized from the JSON schema the
 * agents request in `format`, reusing facts from the prompt (the first public IPv4,
 * runbook file names) so outputs stay grounded and pass the evaluation gates.
 * It exercises the real agent code paths (HTTP client, LangGraph graph, schema
 * validation, guardrails, telemetry). It is NOT a language model: for real
 * reasoning, run Ollama locally (also free) and point OLLAMA_HOST at it.
 *
 *   node scripts/ollama-demo-stub.mjs            # listens on :11434 (PORT to override)
 *
 * Test control (used by the pytest suite to script agent behaviour):
 *   PUT    /__scenario  {"responses": [<object|string>, ...]}  next chat replies, in order
 *                       {"fail": {"status": 500, "times": 1}}   fail the next N chat calls
 *   GET    /__scenario  remaining scripted replies and the chat calls received so far
 *   DELETE /__scenario  back to schema-synthesized replies; clears the call log
 * A scripted object reply is sent as JSON; a string is sent verbatim (e.g. invalid JSON).
 */
import http from 'node:http';

const port = Number(process.env.PORT ?? 11434);

/** Scripted behaviour for tests. Empty = synthesize from the requested schema. */
const scenario = { responses: [], fail: null, calls: [] };

function resetScenario() {
  scenario.responses = [];
  scenario.fail = null;
  scenario.calls = [];
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

function handleScenario(req, res, body) {
  if (req.method === 'DELETE') {
    resetScenario();
    return sendJson(res, 200, { reset: true });
  }
  if (req.method === 'GET') {
    return sendJson(res, 200, {
      remainingResponses: scenario.responses.length,
      fail: scenario.fail,
      calls: scenario.calls,
    });
  }
  if (req.method === 'PUT') {
    const input = JSON.parse(body || '{}');
    if (input.responses !== undefined && !Array.isArray(input.responses)) {
      return sendJson(res, 400, { error: 'responses must be an array' });
    }
    scenario.responses = input.responses ?? [];
    scenario.fail = input.fail ? { status: 500, times: 1, ...input.fail } : null;
    scenario.calls = [];
    return sendJson(res, 200, { responses: scenario.responses.length, fail: scenario.fail });
  }
  return sendJson(res, 405, { error: 'method not allowed' });
}

function facts(messages) {
  const text = messages.map((m) => m.content ?? '').join('\n');
  const ip = text.match(/\b(?:203\.0\.113|198\.51\.100|192\.0\.2)\.\d{1,3}\b/)?.[0];
  const runbooks = [...new Set(text.match(/[a-z0-9-]+\.md/g) ?? [])].filter(
    (f) => f !== 'readme.md'
  );
  return { ip, runbooks };
}

function synthesize(schema, key, f) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      const out = {};
      for (const [k, s] of Object.entries(schema.properties ?? {})) out[k] = synthesize(s, k, f);
      return out;
    }
    case 'array':
      if (key === 'citedRunbooks') return f.runbooks.slice(0, 1);
      return [synthesize(schema.items ?? { type: 'string' }, key, f)];
    case 'number':
    case 'integer':
      return Math.min(schema.maximum ?? 0.8, 0.8);
    case 'boolean':
      return false;
    default: {
      const subject = f.ip ? `activity from ${f.ip}` : 'the reported activity';
      return `[demo stub] ${key ?? 'value'} based on ${subject}`;
    }
  }
}

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        if (req.url?.startsWith('/__scenario')) return handleScenario(req, res, body);
        if (req.method === 'GET') return sendJson(res, 200, { status: 'ok', stub: true });

        const { model = 'demo-stub', messages = [], format } = JSON.parse(body || '{}');
        scenario.calls.push({ model, format: Boolean(format), at: new Date().toISOString() });
        if (scenario.fail && scenario.fail.times > 0) {
          scenario.fail.times -= 1;
          const { status } = scenario.fail;
          if (scenario.fail.times === 0) scenario.fail = null;
          return sendJson(res, status, { error: 'scripted failure' });
        }
        const scripted = scenario.responses.length > 0 ? scenario.responses.shift() : undefined;
        const content =
          scripted === undefined
            ? JSON.stringify(synthesize(format, undefined, facts(messages)))
            : typeof scripted === 'string'
              ? scripted
              : JSON.stringify(scripted);
        sendJson(res, 200, {
          model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content },
          done: true,
          prompt_eval_count: Math.ceil(body.length / 4),
          eval_count: Math.ceil(content.length / 4),
        });
      } catch {
        sendJson(res, 400, { error: 'invalid request' });
      }
    });
  })
  .listen(port, () => console.log(`[ollama-demo-stub] listening on :${port}`));
