import { Ollama } from 'ollama';
import type { Message } from 'ollama';
import { z } from 'zod';
import type {
  AgentInvestigation,
  FailureHistory,
  TestResult,
  WebhookPayload,
} from '@orchestrator/shared-types';
import type { JiraIssue } from './jira-adapter';

const InvestigationSchema = z.object({
  suspectedRootCause: z.string().min(1),
  evidence: z.array(z.string()).max(8),
  recommendedAction: z.enum(['create_issue', 'update_issue', 'notify_only', 'human_review']),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
});

export interface InvestigationContext {
  test: TestResult;
  run: WebhookPayload;
  fingerprint: string;
  deterministicClassification: string;
  history: FailureHistory | null;
  existingIssue: JiraIssue | null;
}

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'get_failure_history',
      description: 'Get prior outcomes and recurrence information for this exact failure fingerprint.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_related_jira_issue',
      description: 'Get the Jira issue already associated with this exact failure fingerprint, if one exists.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

const outputFormat = {
  type: 'object',
  properties: {
    suspectedRootCause: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    recommendedAction: {
      type: 'string',
      enum: ['create_issue', 'update_issue', 'notify_only', 'human_review'],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    explanation: { type: 'string' },
  },
  required: ['suspectedRootCause', 'evidence', 'recommendedAction', 'confidence', 'explanation'],
};

export async function investigateFailure(
  context: InvestigationContext
): Promise<AgentInvestigation | undefined> {
  if (process.env.AI_ENABLED !== 'true') return undefined;

  const model = process.env.OLLAMA_MODEL ?? 'qwen3:4b';
  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const timeoutMs = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS ?? '30000', 10);
  const client = new Ollama({
    host,
    fetch: (input, init) => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;
      return fetch(input, { ...init, signal });
    },
  });
  const toolsUsed: string[] = [];
  const messages: Message[] = [
    {
      role: 'system',
      content: [
        'You are a guarded test-failure investigation agent.',
        'Use the available tools when historical or Jira evidence is relevant.',
        'Do not invent logs, code, history, or issue data.',
        'The deterministic classification is a safety signal; explain disagreements and recommend human_review when evidence is insufficient.',
        'Return only JSON matching the requested schema.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        goal: 'Investigate this CI failure and recommend the safest next action.',
        failure: {
          testId: context.test.testId,
          title: context.test.title,
          suite: context.test.suite,
          file: context.test.file,
          retry: context.test.retry,
          error: context.test.error,
          metadata: context.test.metadata,
          fingerprint: context.fingerprint,
          deterministicClassification: context.deterministicClassification,
          repository: context.run.repository,
          branch: context.run.branch,
          environment: context.run.environment,
        },
      }),
    },
  ];

  try {
    for (let step = 0; step < 3; step++) {
      const response = await client.chat({ model, messages, tools, format: outputFormat, stream: false });
      const calls = response.message.tool_calls ?? [];
      if (calls.length === 0) {
        const parsed = InvestigationSchema.parse(JSON.parse(response.message.content));
        return { ...parsed, toolsUsed, model };
      }

      // Preserve the assistant's tool calls in the transcript so the next
      // reasoning step can associate each tool result with its request.
      messages.push(response.message);
      for (const call of calls) {
        const name = call.function.name;
        toolsUsed.push(name);
        let result: unknown;
        if (name === 'get_failure_history') result = context.history ?? { found: false };
        else if (name === 'get_related_jira_issue') result = context.existingIssue ?? { found: false };
        else result = { error: `Unknown tool: ${name}` };
        messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
      }
    }
    throw new Error('Agent exceeded its maximum tool-call steps');
  } catch (error) {
    console.warn('[Agent] Investigation unavailable; continuing with deterministic routing:', error);
    return undefined;
  }
}
