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
 */
import http from 'node:http';

const port = Number(process.env.PORT ?? 11434);

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
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', stub: true }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const { model = 'demo-stub', messages = [], format } = JSON.parse(body || '{}');
        const content = JSON.stringify(synthesize(format, undefined, facts(messages)));
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            model,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content },
            done: true,
            prompt_eval_count: Math.ceil(body.length / 4),
            eval_count: Math.ceil(content.length / 4),
          })
        );
      } catch {
        res.statusCode = 400;
        res.end('{"error":"invalid request"}');
      }
    });
  })
  .listen(port, () => console.log(`[ollama-demo-stub] listening on :${port}`));
