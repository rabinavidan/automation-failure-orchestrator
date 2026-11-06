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
 *   POST   /__scenario/scripts {"match": "<text>", "responses": [...]}
 *                       replies used only for requests whose messages contain <text>, so
 *                       parallel tests can each script their own investigation
 *   GET    /__scenario  remaining scripted replies and the chat calls received so far
 *   DELETE /__scenario  back to schema-synthesized replies; clears the call log
 * A scripted object reply is sent as JSON; a string is sent verbatim (e.g. invalid JSON).
 * A reply of the form {"tool_calls": [{"function": {"name": "...", "arguments": {...}}}]} is
 * returned as a tool-calling message (empty content), like Ollama's tool calling.
 * The call log records each request's `think` flag and whether tools were offered.
 *
 * Embeddings (POST /api/embeddings {prompt} and /api/embed {input}) are deterministic hashed
 * bag-of-words vectors: texts sharing words are close, unrelated texts are not. That makes
 * retrieval testable without a model; it is lexical overlap, not semantics.
 *   PUT    /__scenario  {"embedFail": {"status": 500, "times": 1}} fail the next N embed calls
 * GET /__scenario also reports `embedCalls`, the number of texts embedded so far.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';

const port = Number(process.env.PORT ?? 11434);

/** Scripted behaviour for tests. Empty = synthesize from the requested schema. */
const scenario = {
  responses: [],
  fail: null,
  calls: [],
  scripts: [],
  embedFail: null,
  embedCalls: 0,
};

function resetScenario() {
  scenario.responses = [];
  scenario.fail = null;
  scenario.calls = [];
  scenario.scripts = [];
  scenario.embedFail = null;
  scenario.embedCalls = 0;
}

const EMBEDDING_DIMENSIONS = 256;

/** Hashed bag of words, L2-normalized. Never the zero vector, so cosine is always defined. */
function embed(text) {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 0.01;
  for (const token of String(text)
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g) ?? []) {
    const digest = createHash('sha256').update(token).digest();
    vector[1 + (digest.readUInt16BE(0) % (EMBEDDING_DIMENSIONS - 1))] += 1;
  }
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

function handleEmbeddings(req, res, body) {
  if (scenario.embedFail && scenario.embedFail.times > 0) {
    scenario.embedFail.times -= 1;
    const { status } = scenario.embedFail;
    if (scenario.embedFail.times === 0) scenario.embedFail = null;
    return sendJson(res, status, { error: 'scripted embedding failure' });
  }
  const { model = 'stub-embed', prompt, input } = JSON.parse(body || '{}');
  if (req.url === '/api/embeddings') {
    scenario.embedCalls += 1;
    return sendJson(res, 200, { embedding: embed(prompt ?? '') });
  }
  const texts = Array.isArray(input) ? input : [input ?? ''];
  scenario.embedCalls += texts.length;
  return sendJson(res, 200, { model, embeddings: texts.map(embed) });
}

/** The next scripted reply for this request: a matching script first, then the global queue. */
function nextScripted(requestText) {
  const script = scenario.scripts.find(
    (s) => s.responses.length > 0 && requestText.includes(s.match)
  );
  if (script) return script.responses.shift();
  return scenario.responses.length > 0 ? scenario.responses.shift() : undefined;
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

function handleScenario(req, res, body) {
  if (req.url === '/__scenario/scripts' && req.method === 'POST') {
    const input = JSON.parse(body || '{}');
    if (typeof input.match !== 'string' || !input.match || !Array.isArray(input.responses)) {
      return sendJson(res, 400, { error: 'match (string) and responses (array) are required' });
    }
    scenario.scripts.push({ match: input.match, responses: [...input.responses] });
    return sendJson(res, 201, { scripts: scenario.scripts.length });
  }
  if (req.method === 'DELETE') {
    resetScenario();
    return sendJson(res, 200, { reset: true });
  }
  if (req.method === 'GET') {
    return sendJson(res, 200, {
      remainingResponses: scenario.responses.length,
      scripts: scenario.scripts.map((s) => ({ match: s.match, remaining: s.responses.length })),
      fail: scenario.fail,
      calls: scenario.calls,
      embedFail: scenario.embedFail,
      embedCalls: scenario.embedCalls,
    });
  }
  if (req.method === 'PUT') {
    const input = JSON.parse(body || '{}');
    if (input.responses !== undefined && !Array.isArray(input.responses)) {
      return sendJson(res, 400, { error: 'responses must be an array' });
    }
    scenario.responses = input.responses ?? [];
    scenario.fail = input.fail ? { status: 500, times: 1, ...input.fail } : null;
    scenario.embedFail = input.embedFail ? { status: 500, times: 1, ...input.embedFail } : null;
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
        if (req.url === '/api/embeddings' || req.url === '/api/embed') {
          return handleEmbeddings(req, res, body);
        }

        const {
          model = 'demo-stub',
          messages = [],
          format,
          think,
          tools,
        } = JSON.parse(body || '{}');
        scenario.calls.push({
          model,
          format: Boolean(format),
          think: think ?? null,
          tools: Array.isArray(tools) ? tools.map((t) => t.function?.name) : [],
          at: new Date().toISOString(),
        });
        if (scenario.fail && scenario.fail.times > 0) {
          scenario.fail.times -= 1;
          const { status } = scenario.fail;
          if (scenario.fail.times === 0) scenario.fail = null;
          return sendJson(res, status, { error: 'scripted failure' });
        }
        const scripted = nextScripted(JSON.stringify(messages));
        if (scripted && typeof scripted === 'object' && Array.isArray(scripted.tool_calls)) {
          return sendJson(res, 200, {
            model,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: '', tool_calls: scripted.tool_calls },
            done: true,
            prompt_eval_count: Math.ceil(body.length / 4),
            eval_count: 8,
          });
        }
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
