/**
 * Runtime capability report: what each independent dimension is *configured* to do and what
 * is *available* right now. Configuration comes from env vars; availability comes from a short
 * probe. Never returns secrets: hosts are reduced to origin without credentials, and credential
 * env vars are reported only as configured/not configured.
 */

export type ModelBackend = 'disabled' | 'stub' | 'real' | 'unreachable';

export interface ModelCapability {
  configured: 'disabled' | 'enabled';
  /** What actually answers on OLLAMA_HOST: the deterministic demo stub, a real Ollama, or nothing. */
  backend: ModelBackend;
  provider: 'ollama';
  host: string | null;
  model: string;
  /** Whether `model` is in the real Ollama's local model list; null when not determinable. */
  modelInstalled: boolean | null;
  orchestration: 'supervisor' | 'single_agent';
  graphVersion: string;
  ragEnabled: boolean;
  embeddingModel: string;
  detail?: string;
}

export interface RuntimeCapabilities {
  generatedAt: string;
  model: ModelCapability;
  integrations: {
    /** The INTEGRATION_MODE label. Adapters route by URL, so the targets below are authoritative. */
    mode: 'mock' | 'live';
    jiraTarget: string | null;
    slackTarget: string | null;
    jiraCredentialsConfigured: boolean;
    slackWebhookConfigured: boolean;
  };
  queue: {
    mode: 'in_process' | 'sqs_local_emulator' | 'sqs_aws';
    queueUrlConfigured: boolean;
  };
  enrichment: {
    configured: boolean;
    available: boolean;
    mode: string | null;
  };
  /** Human-readable warnings, e.g. "stub output is not real-model evidence". */
  notes: string[];
}

type Env = Record<string, string | undefined>;

type Fetcher = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const PROBE_TIMEOUT_MS = 1500;

/** Reduce a URL to scheme://host[:port]: strips userinfo, path and query so nothing secret leaks. */
export function safeOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

async function probe(fetcher: Fetcher, url: string): Promise<Response | null> {
  try {
    return await fetcher(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

/**
 * Identify what answers on the Ollama host. The repository's demo stub answers `GET /` with
 * JSON `{ stub: true }`; a real Ollama answers with plain text and exposes `/api/tags`.
 */
export async function detectModelBackend(
  env: Env = process.env,
  fetcher: Fetcher = fetch
): Promise<{ backend: ModelBackend; modelInstalled: boolean | null; detail?: string }> {
  if (env.AI_ENABLED !== 'true') return { backend: 'disabled', modelInstalled: null };
  const host = env.OLLAMA_HOST ?? 'http://localhost:11434';
  const model = env.OLLAMA_MODEL ?? 'qwen3:4b';
  const root = await probe(fetcher, host);
  if (!root || !root.ok) {
    return { backend: 'unreachable', modelInstalled: null, detail: 'Ollama host did not answer' };
  }
  const text = await root.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { stub?: unknown };
    if (body && body.stub === true) {
      return {
        backend: 'stub',
        modelInstalled: null,
        detail: 'deterministic demo stub (scripts/ollama-demo-stub.mjs), not a language model',
      };
    }
  } catch {
    // Real Ollama answers GET / with plain text ("Ollama is running").
  }
  const tags = await probe(fetcher, `${host.replace(/\/$/, '')}/api/tags`);
  if (!tags || !tags.ok) return { backend: 'real', modelInstalled: null };
  const listing = (await tags.json().catch(() => ({}))) as { models?: { name?: string }[] };
  const names = (listing.models ?? []).map((m) => m.name ?? '');
  const installed = names.some((n) => n === model || n === `${model}:latest`);
  return {
    backend: 'real',
    modelInstalled: installed,
    detail: installed ? undefined : `model ${model} is not pulled on the Ollama host`,
  };
}

let cachedBackend: { at: number; value: Awaited<ReturnType<typeof detectModelBackend>> } | null =
  null;
const BACKEND_CACHE_MS = 30_000;

/** Cached backend detection used when stamping investigations; avoids a probe per test. */
export async function currentModelBackend(): Promise<ModelBackend> {
  if (cachedBackend && Date.now() - cachedBackend.at < BACKEND_CACHE_MS) {
    return cachedBackend.value.backend;
  }
  const value = await detectModelBackend();
  cachedBackend = { at: Date.now(), value };
  return value.backend;
}

export function resetModelBackendCache(): void {
  cachedBackend = null;
}

export function queueMode(env: Env = process.env): RuntimeCapabilities['queue'] {
  if (env.INVESTIGATION_QUEUE !== 'sqs') {
    return { mode: 'in_process', queueUrlConfigured: Boolean(env.INVESTIGATION_QUEUE_URL) };
  }
  return {
    mode: env.AWS_ENDPOINT_URL ? 'sqs_local_emulator' : 'sqs_aws',
    queueUrlConfigured: Boolean(env.INVESTIGATION_QUEUE_URL),
  };
}

export async function getRuntimeCapabilities(
  env: Env = process.env,
  fetcher: Fetcher = fetch
): Promise<RuntimeCapabilities> {
  const multiAgent = env.MULTI_AGENT_ENABLED === 'true';
  const [modelProbe, enrichmentProbe] = await Promise.all([
    detectModelBackend(env, fetcher),
    env.ENRICHMENT_URL
      ? probe(fetcher, `${env.ENRICHMENT_URL.replace(/\/$/, '')}/health`)
      : Promise.resolve(null),
  ]);
  let enrichmentMode: string | null = null;
  if (enrichmentProbe?.ok) {
    const body = (await enrichmentProbe.json().catch(() => ({}))) as { mode?: unknown };
    enrichmentMode = typeof body.mode === 'string' ? body.mode : null;
  }

  const model: ModelCapability = {
    configured: env.AI_ENABLED === 'true' ? 'enabled' : 'disabled',
    backend: modelProbe.backend,
    provider: 'ollama',
    host:
      env.AI_ENABLED === 'true' ? safeOrigin(env.OLLAMA_HOST ?? 'http://localhost:11434') : null,
    model: env.OLLAMA_MODEL ?? 'qwen3:4b',
    modelInstalled: modelProbe.modelInstalled,
    orchestration: multiAgent ? 'supervisor' : 'single_agent',
    graphVersion: multiAgent ? 'failure-supervisor-v1' : 'failure-agent-v1',
    ragEnabled: env.RAG_ENABLED === 'true',
    embeddingModel: env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
    ...(modelProbe.detail ? { detail: modelProbe.detail } : {}),
  };

  const notes: string[] = [];
  if (model.backend === 'disabled') {
    notes.push('AI disabled: deterministic classification and policy only, no AI investigation.');
  } else if (model.backend === 'stub') {
    notes.push(
      'Model answers come from the deterministic demo stub; they are not real-model evidence.'
    );
  } else if (model.backend === 'unreachable') {
    notes.push(
      'AI enabled but the model host is unreachable: investigations fall back to deterministic processing.'
    );
  }
  const integrationMode = env.INTEGRATION_MODE === 'mock' ? 'mock' : 'live';
  if (integrationMode === 'mock') {
    notes.push('Jira/Slack actions go to in-memory mock integrations.');
  }

  return {
    generatedAt: new Date().toISOString(),
    model,
    integrations: {
      mode: integrationMode,
      jiraTarget: safeOrigin(env.JIRA_BASE_URL ?? 'http://localhost:3002'),
      slackTarget: safeOrigin(env.SLACK_WEBHOOK_URL),
      jiraCredentialsConfigured: Boolean(env.JIRA_API_TOKEN && env.JIRA_EMAIL),
      slackWebhookConfigured: Boolean(env.SLACK_WEBHOOK_URL),
    },
    queue: queueMode(env),
    enrichment: {
      configured: Boolean(env.ENRICHMENT_URL),
      available: Boolean(enrichmentProbe?.ok),
      mode: enrichmentMode,
    },
    notes,
  };
}
