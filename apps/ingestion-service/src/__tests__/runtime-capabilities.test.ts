import { describe, expect, it } from 'vitest';
import {
  detectModelBackend,
  getRuntimeCapabilities,
  queueMode,
  safeOrigin,
} from '../services/runtime-capabilities';

type Route = (url: string) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>) {
  return async (input: string): Promise<Response> => {
    const route = routes[input];
    if (!route) throw new Error(`ECONNREFUSED ${input}`);
    return route(input);
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('detectModelBackend', () => {
  it('reports disabled without probing when AI is off', async () => {
    const result = await detectModelBackend({ AI_ENABLED: 'false' }, async () => {
      throw new Error('must not probe');
    });
    expect(result.backend).toBe('disabled');
  });

  it('identifies the deterministic demo stub so it cannot pass as a real model', async () => {
    const result = await detectModelBackend(
      { AI_ENABLED: 'true', OLLAMA_HOST: 'http://stub:11434' },
      fakeFetch({ 'http://stub:11434': () => json({ status: 'ok', stub: true }) })
    );
    expect(result.backend).toBe('stub');
    expect(result.detail).toMatch(/not a language model/);
  });

  it('identifies a real Ollama and checks the configured model is pulled', async () => {
    const fetcher = fakeFetch({
      'http://ollama:11434': () => new Response('Ollama is running'),
      'http://ollama:11434/api/tags': () => json({ models: [{ name: 'qwen3:4b' }] }),
    });
    const installed = await detectModelBackend(
      { AI_ENABLED: 'true', OLLAMA_HOST: 'http://ollama:11434', OLLAMA_MODEL: 'qwen3:4b' },
      fetcher
    );
    expect(installed).toEqual({ backend: 'real', modelInstalled: true, detail: undefined });

    const missing = await detectModelBackend(
      { AI_ENABLED: 'true', OLLAMA_HOST: 'http://ollama:11434', OLLAMA_MODEL: 'llama3:8b' },
      fetcher
    );
    expect(missing.backend).toBe('real');
    expect(missing.modelInstalled).toBe(false);
  });

  it('reports unreachable when nothing answers', async () => {
    const result = await detectModelBackend(
      { AI_ENABLED: 'true', OLLAMA_HOST: 'http://nowhere:11434' },
      fakeFetch({})
    );
    expect(result.backend).toBe('unreachable');
  });
});

describe('getRuntimeCapabilities', () => {
  it('never returns secret values', async () => {
    const env = {
      AI_ENABLED: 'true',
      OLLAMA_HOST: 'http://user:hunter2@ollama:11434/some/path',
      INTEGRATION_MODE: 'live',
      JIRA_BASE_URL: 'https://acme.atlassian.net/rest?token=abc',
      JIRA_EMAIL: 'bot@acme.example',
      JIRA_API_TOKEN: 'jira-secret-token',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T0/B0/slack-secret',
      WEBHOOK_SECRET: 'webhook-secret',
      ENRICHMENT_URL: 'http://enrichment:3003',
    };
    const caps = await getRuntimeCapabilities(env, fakeFetch({}));
    const serialized = JSON.stringify(caps);
    for (const secret of [
      'hunter2',
      'jira-secret-token',
      'slack-secret',
      'webhook-secret',
      'token=abc',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(caps.model.host).toBe('http://ollama:11434');
    expect(caps.integrations).toMatchObject({
      mode: 'live',
      jiraTarget: 'https://acme.atlassian.net',
      slackTarget: 'https://hooks.slack.com',
      jiraCredentialsConfigured: true,
      slackWebhookConfigured: true,
    });
  });

  it('reports configured mode and availability separately', async () => {
    const caps = await getRuntimeCapabilities(
      {
        AI_ENABLED: 'true',
        MULTI_AGENT_ENABLED: 'true',
        OLLAMA_HOST: 'http://ollama:11434',
        ENRICHMENT_URL: 'http://enrichment:3003',
        INTEGRATION_MODE: 'mock',
      },
      fakeFetch({ 'http://enrichment:3003/health': () => json({ status: 'ok', mode: 'mock' }) })
    );
    expect(caps.model).toMatchObject({
      configured: 'enabled',
      backend: 'unreachable',
      orchestration: 'supervisor',
      graphVersion: 'failure-supervisor-v1',
    });
    expect(caps.enrichment).toEqual({ configured: true, available: true, mode: 'mock' });
    expect(caps.notes.join(' ')).toMatch(/fall back to deterministic/);
  });
});

describe('queueMode', () => {
  it('distinguishes in-process, local SQS emulation and AWS', () => {
    expect(queueMode({}).mode).toBe('in_process');
    expect(
      queueMode({ INVESTIGATION_QUEUE: 'sqs', AWS_ENDPOINT_URL: 'http://moto:5000' }).mode
    ).toBe('sqs_local_emulator');
    expect(queueMode({ INVESTIGATION_QUEUE: 'sqs', INVESTIGATION_QUEUE_URL: 'x' })).toEqual({
      mode: 'sqs_aws',
      queueUrlConfigured: true,
    });
  });

  it('safeOrigin strips credentials and paths', () => {
    expect(safeOrigin('https://u:p@host:8443/a?b=c')).toBe('https://host:8443');
    expect(safeOrigin('not a url')).toBeNull();
    expect(safeOrigin(undefined)).toBeNull();
  });
});
