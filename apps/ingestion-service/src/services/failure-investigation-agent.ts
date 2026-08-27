import { Annotation, Command, END, START, StateGraph, interrupt, isInterrupted } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { Ollama } from 'ollama';
import type { Message, Tool, ToolCall } from 'ollama';
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
import { searchRepositoryKnowledge } from './repository-knowledge';
import { query } from '../db/client';
import {
  createMultiAgentInvestigationGraph,
  isInterrupted as isMultiAgentInterrupted,
  resumeMultiAgentInvestigation,
} from './multi-agent-investigation';

const MAX_REASONING_STEPS = 4;

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

const tools: Tool[] = [
  { type: 'function', function: { name: 'get_failure_history', description: 'Get prior outcomes and recurrence information for this exact failure fingerprint.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_related_jira_issue', description: 'Get the Jira issue already associated with this exact failure fingerprint, if one exists.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'search_repository_context', description: 'Semantically search indexed repository code and documentation for evidence relevant to this failure. Results include source paths and chunk identifiers.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'A focused technical search query derived from the failure.' } }, required: ['query'] } } },
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
  chat(input: { model: string; messages: Message[]; tools?: Tool[]; format: Record<string, unknown>; stream: false; think?: false }): Promise<{ message: Message }>;
}

export interface InvestigationGraphOptions {
  checkpointer?: BaseCheckpointSaver;
  threadId?: string;
  audit?: AgentAuditSink;
  requireApproval?: boolean;
  knowledgeSearch?: typeof searchRepositoryKnowledge;
}

export interface FailureInvestigationOutcome {
  investigation?: AgentInvestigation;
  approvalPending?: boolean;
  threadId?: string;
}

const InvestigationState = Annotation.Root({
  context: Annotation<InvestigationContext>(),
  model: Annotation<string>(),
  messages: Annotation<Message[]>(),
  pendingCalls: Annotation<ToolCall[]>(),
  toolsUsed: Annotation<string[]>(),
  reasoningSteps: Annotation<number>(),
  result: Annotation<AgentInvestigation | undefined>(),
  approvalStatus: Annotation<'not_required' | 'pending' | 'approved' | 'rejected'>(),
  ragSources: Annotation<Array<{ path: string; chunk: number; score: number }>>(),
});

function initialMessages(context: InvestigationContext): Message[] {
  return [
    {
      role: 'system',
      content: [
        'You are a guarded test-failure investigation agent.',
        'Use the available tools when historical or Jira evidence is relevant.',
        'When repository knowledge is enabled, you must use search_repository_context at least once before returning a final investigation.',
        'Call only tools from the provided schema and preserve their names exactly.',
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
      if (process.env.RAG_ENABLED === 'true' && !state.toolsUsed.includes('search_repository_context')) {
        const query = [
          state.context.test.title,
          state.context.test.file,
          state.context.test.error?.name,
          state.context.test.error?.message,
          state.context.test.metadata?.service,
        ].filter(Boolean).join(' ');
        const requiredRagCall: ToolCall = {
          function: { name: 'search_repository_context', arguments: { query } },
        };
        await options.audit?.record({
          node: 'reason',
          status: 'completed',
          details: { step: state.reasoningSteps + 1, requestedTools: ['search_repository_context'], policyEnforced: true },
        });
        return { pendingCalls: [requiredRagCall], reasoningSteps: state.reasoningSteps + 1 };
      }
      const parsed = InvestigationSchema.parse(JSON.parse(response.message.content));
      await options.audit?.record({
        node: 'reason',
        status: 'completed',
        details: { step: state.reasoningSteps + 1, confidence: parsed.confidence },
      });
      return { pendingCalls: [], reasoningSteps: state.reasoningSteps + 1, result: { ...parsed, toolsUsed: state.toolsUsed, model: state.model, sources: state.ragSources } };
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
    const ragSources = [...state.ragSources];
    for (const call of state.pendingCalls) {
      const name = call.function.name;
      used.push(name);
      let result: unknown;
      if (name === 'get_failure_history') result = state.context.history ?? { found: false };
      else if (name === 'get_related_jira_issue') result = state.context.existingIssue ?? { found: false };
      else if (name === 'search_repository_context') {
        if (process.env.RAG_ENABLED !== 'true') result = { available: false, reason: 'RAG is disabled' };
        else {
          try {
            const requestedQuery = String(call.function.arguments?.query ?? '').trim();
            const searchText = requestedQuery || [
              state.context.test.title,
              state.context.test.error?.name,
              state.context.test.error?.message,
              state.context.test.metadata?.service,
            ].filter(Boolean).join(' ');
            const matches = await (options.knowledgeSearch ?? searchRepositoryKnowledge)(searchText, 4);
            for (const match of matches) {
              ragSources.push({ path: match.sourcePath, chunk: match.chunkIndex, score: match.score });
            }
            result = { available: true, matches };
          } catch (error) {
            result = { available: false, reason: error instanceof Error ? error.message : 'Search failed' };
          }
        }
      }
      else result = { error: `Unknown tool: ${name}` };
      toolMessages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
    }
    await options.audit?.record({
      node: 'execute_tools',
      status: 'completed',
      details: { tools: state.pendingCalls.map((call) => call.function.name) },
    });
    return { messages: [...state.messages, ...toolMessages], pendingCalls: [], toolsUsed: used, ragSources };
  };

  const finalize = async (state: typeof InvestigationState.State) => {
    await options.audit?.record({
      node: 'finalize',
      status: 'started',
      details: { reason: 'tool_budget_exhausted' },
    });
    const response = await client.chat({
      model: state.model,
      messages: [
        ...state.messages,
        { role: 'user', content: 'The tool budget is exhausted. Do not call another tool. Return the final investigation JSON now using only the gathered evidence.' },
      ],
      format: outputFormat,
      stream: false,
    });
    try {
      const parsed = InvestigationSchema.parse(JSON.parse(response.message.content));
      await options.audit?.record({ node: 'finalize', status: 'completed', details: { confidence: parsed.confidence } });
      return { result: { ...parsed, toolsUsed: state.toolsUsed, model: state.model, sources: state.ragSources } };
    } catch {
      await options.audit?.record({ node: 'finalize', status: 'bounded', details: { reason: 'invalid_final_output' } });
      return {};
    }
  };

  const requestApproval = async (state: typeof InvestigationState.State) => {
    const decision = interrupt({
      type: 'failure_action_approval',
      fingerprint: state.context.fingerprint,
      testId: state.context.test.testId,
      classification: state.context.deterministicClassification,
      recommendedAction: state.result?.recommendedAction,
      confidence: state.result?.confidence,
      explanation: state.result?.explanation,
    }) as { approved: boolean; reviewer?: string; comment?: string };
    const approvalStatus = decision.approved ? 'approved' : 'rejected';
    await options.audit?.record({
      node: 'request_approval',
      status: 'completed',
      details: { decision: approvalStatus, reviewer: decision.reviewer },
    });
    return { approvalStatus };
  };

  const builder = new StateGraph(InvestigationState)
    .addNode('reason', reason)
    .addNode('execute_tools', executeTools)
    .addNode('finalize', finalize)
    .addNode('request_approval', requestApproval)
    .addEdge(START, 'reason')
    .addConditionalEdges('reason', (state) => {
      if (!state.result && state.reasoningSteps < MAX_REASONING_STEPS) return 'execute_tools';
      if (!state.result) return 'finalize';
      if (options.requireApproval && state.result?.recommendedAction === 'human_review') return 'request_approval';
      return END;
    })
    .addEdge('execute_tools', 'reason')
    .addConditionalEdges('finalize', (state) =>
      options.requireApproval && state.result?.recommendedAction === 'human_review'
        ? 'request_approval'
        : END
    )
    .addEdge('request_approval', END);
  return builder.compile({ checkpointer: options.checkpointer });
}

export async function runFailureInvestigationGraph(context: InvestigationContext, client: InvestigationModel, model: string, options: InvestigationGraphOptions = {}): Promise<AgentInvestigation | undefined> {
  const finalState = await createFailureInvestigationGraph(client, options).invoke({
    context, model, messages: initialMessages(context), pendingCalls: [], toolsUsed: [], reasoningSteps: 0, result: undefined, approvalStatus: 'not_required', ragSources: [],
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

export async function investigateFailure(context: InvestigationContext): Promise<FailureInvestigationOutcome> {
  if (process.env.AI_ENABLED !== 'true') return {};
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
    const useMultiAgent = process.env.MULTI_AGENT_ENABLED === 'true';
    const graphOptions = {
      checkpointer,
      threadId,
      audit: createDatabaseAuditSink(threadId),
      requireApproval: true,
    };
    const graph = useMultiAgent
      ? createMultiAgentInvestigationGraph(client, graphOptions)
      : createFailureInvestigationGraph(client, graphOptions);
    const initialState = useMultiAgent
      ? { context, model, reports: [], toolsUsed: [], sources: [], result: undefined, approvalStatus: 'not_required' as const }
      : { context, model, messages: initialMessages(context), pendingCalls: [], toolsUsed: [], reasoningSteps: 0, result: undefined, approvalStatus: 'not_required' as const, ragSources: [] };
    const finalState = await graph.invoke(initialState, { configurable: { thread_id: threadId } });
    const approvalPending = useMultiAgent ? isMultiAgentInterrupted(finalState) : isInterrupted(finalState);
    await finishAgentExecution(
      threadId,
      approvalPending ? 'paused' : finalState.result ? 'completed' : 'bounded',
      finalState.result
    );
    return { investigation: finalState.result, approvalPending, threadId };
  } catch (error) {
    await finishAgentExecution(threadId, 'failed').catch(() => undefined);
    console.warn('[Agent] Investigation unavailable; continuing with deterministic routing:', error);
    return {};
  }
}

export async function resumeFailureInvestigation(input: {
  threadId: string;
  approved: boolean;
  reviewer: string;
  comment?: string;
}): Promise<{ investigation?: AgentInvestigation; status: 'approved' | 'rejected' }> {
  const checkpointer = await getAgentCheckpointer();
  const audit = createDatabaseAuditSink(input.threadId);
  const execution = await query<{ orchestration: string | null }>(
    `SELECT final_result->>'orchestration' AS orchestration FROM agent_executions WHERE thread_id = $1`,
    [input.threadId]
  );
  if (execution[0]?.orchestration === 'supervisor') {
    const resumed = await resumeMultiAgentInvestigation({ ...input, checkpointer, audit });
    await finishAgentExecution(input.threadId, resumed.status === 'approved' ? 'completed' : 'rejected', resumed.investigation);
    return resumed;
  }
  const client: InvestigationModel = {
    async chat() {
      throw new Error('The reasoning node must not run while resuming an approval checkpoint');
    },
  };
  const graph = createFailureInvestigationGraph(client, {
    checkpointer,
    threadId: input.threadId,
    audit,
    requireApproval: true,
  });
  const finalState = await graph.invoke(
    new Command({
      resume: { approved: input.approved, reviewer: input.reviewer, comment: input.comment },
    }),
    { configurable: { thread_id: input.threadId } }
  );
  const status = finalState.approvalStatus === 'approved' ? 'approved' : 'rejected';
  await finishAgentExecution(input.threadId, status === 'approved' ? 'completed' : 'rejected', finalState.result);
  return { investigation: finalState.result, status };
}
