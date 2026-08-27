import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { Ollama } from 'ollama';
import type { Message, ToolCall } from 'ollama';
import { z } from 'zod';
import type { AgentInvestigation, FailureHistory, TestResult, WebhookPayload } from '@orchestrator/shared-types';
import type { JiraIssue } from './jira-adapter';
import { getAgentCheckpointer } from '../db/agent-checkpointer';
import {
  createDatabaseAuditSink,
  finishAgentExecution,
  startAgentExecution,
} from './agent-execution-audit';
import type { AgentAuditSink } from './agent-execution-audit';

const MAX_REASONING_STEPS = 3;

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
  { type: 'function' as const, function: { name: 'get_failure_history', description: 'Get prior outcomes and recurrence information for this exact failure fingerprint.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_related_jira_issue', description: 'Get the Jira issue already associated with this exact failure fingerprint, if one exists.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
];

const outputFormat = {
  type: 'object',
  properties: {
    suspectedRootCause: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    recommendedAction: { type: 'string', enum: ['create_issue', 'update_issue', 'notify_only', 'human_review'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    explanation: { type: 'string' },
  },
  required: ['suspectedRootCause', 'evidence', 'recommendedAction', 'confidence', 'explanation'],
} as const;

export interface InvestigationModel {
  chat(input: { model: string; messages: Message[]; tools: typeof tools; format: typeof outputFormat; stream: false }): Promise<{ message: Message }>;
}

export interface InvestigationGraphOptions {
  checkpointer?: BaseCheckpointSaver;
  threadId?: string;
  audit?: AgentAuditSink;
}

const InvestigationState = Annotation.Root({
  context: Annotation<InvestigationContext>(),
  model: Annotation<string>(),
  messages: Annotation<Message[]>(),
  pendingCalls: Annotation<ToolCall[]>(),
  toolsUsed: Annotation<string[]>(),
  reasoningSteps: Annotation<number>(),
  result: Annotation<AgentInvestigation | undefined>(),
});

function initialMessages(context: InvestigationContext): Message[] {
  return [
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
          testId: context.test.testId, title: context.test.title, suite: context.test.suite,
          file: context.test.file, retry: context.test.retry, error: context.test.error,
          metadata: context.test.metadata, fingerprint: context.fingerprint,
          deterministicClassification: context.deterministicClassification,
          repository: context.run.repository, branch: context.run.branch, environment: context.run.environment,
        },
      }),
    },
  ];
}

export function createFailureInvestigationGraph(
  client: InvestigationModel,
  options: InvestigationGraphOptions = {}
) {
  const reason = async (state: typeof InvestigationState.State) => {
    await options.audit?.record({
      node: 'reason',
      status: 'started',
      details: { step: state.reasoningSteps + 1 },
    });
    const response = await client.chat({ model: state.model, messages: state.messages, tools, format: outputFormat, stream: false });
    const calls = response.message.tool_calls ?? [];
    if (calls.length === 0) {
      const parsed = InvestigationSchema.parse(JSON.parse(response.message.content));
      await options.audit?.record({
        node: 'reason',
        status: 'completed',
        details: { step: state.reasoningSteps + 1, confidence: parsed.confidence },
      });
      return { pendingCalls: [], reasoningSteps: state.reasoningSteps + 1, result: { ...parsed, toolsUsed: state.toolsUsed, model: state.model } };
    }
    await options.audit?.record({
      node: 'reason',
      status: 'completed',
      details: { step: state.reasoningSteps + 1, requestedTools: calls.map((call) => call.function.name) },
    });
    return { messages: [...state.messages, response.message], pendingCalls: calls, reasoningSteps: state.reasoningSteps + 1 };
  };

  const executeTools = async (state: typeof InvestigationState.State) => {
    const toolMessages: Message[] = [];
    const used = [...state.toolsUsed];
    for (const call of state.pendingCalls) {
      const name = call.function.name;
      used.push(name);
      let result: unknown;
      if (name === 'get_failure_history') result = state.context.history ?? { found: false };
      else if (name === 'get_related_jira_issue') result = state.context.existingIssue ?? { found: false };
      else result = { error: `Unknown tool: ${name}` };
      toolMessages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
    }
    await options.audit?.record({
      node: 'execute_tools',
      status: 'completed',
      details: { tools: state.pendingCalls.map((call) => call.function.name) },
    });
    return { messages: [...state.messages, ...toolMessages], pendingCalls: [], toolsUsed: used };
  };

  const builder = new StateGraph(InvestigationState)
    .addNode('reason', reason)
    .addNode('execute_tools', executeTools)
    .addEdge(START, 'reason')
    .addConditionalEdges('reason', (state) => state.result || state.reasoningSteps >= MAX_REASONING_STEPS ? END : 'execute_tools')
    .addEdge('execute_tools', 'reason');
  return builder.compile({ checkpointer: options.checkpointer });
}

export async function runFailureInvestigationGraph(context: InvestigationContext, client: InvestigationModel, model: string, options: InvestigationGraphOptions = {}): Promise<AgentInvestigation | undefined> {
  const finalState = await createFailureInvestigationGraph(client, options).invoke({
    context, model, messages: initialMessages(context), pendingCalls: [], toolsUsed: [], reasoningSteps: 0, result: undefined,
  }, options.threadId ? { configurable: { thread_id: options.threadId } } : undefined);
  if (!finalState.result) {
    await options.audit?.record({
      node: 'graph',
      status: 'bounded',
      details: { maxReasoningSteps: MAX_REASONING_STEPS },
    });
  }
  return finalState.result;
}

export async function investigateFailure(context: InvestigationContext): Promise<AgentInvestigation | undefined> {
  if (process.env.AI_ENABLED !== 'true') return undefined;
  const model = process.env.OLLAMA_MODEL ?? 'qwen3:4b';
  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const timeoutMs = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS ?? '30000', 10);
  const client = new Ollama({
    host,
    fetch: (input, init) => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
      return fetch(input, { ...init, signal });
    },
  });
  const threadId = `${context.run.runId}:${context.fingerprint}`;
  try {
    const checkpointer = await getAgentCheckpointer();
    await startAgentExecution({
      threadId,
      runId: context.run.runId,
      fingerprint: context.fingerprint,
      testId: context.test.testId,
      model,
    });
    const result = await runFailureInvestigationGraph(context, client, model, {
      checkpointer,
      threadId,
      audit: createDatabaseAuditSink(threadId),
    });
    await finishAgentExecution(threadId, result ? 'completed' : 'bounded', result);
    return result;
  } catch (error) {
    await finishAgentExecution(threadId, 'failed').catch(() => undefined);
    console.warn('[Agent] Investigation unavailable; continuing with deterministic routing:', error);
    return undefined;
  }
}
