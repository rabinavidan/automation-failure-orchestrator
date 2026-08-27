import { Annotation, Command, END, START, StateGraph, interrupt, isInterrupted } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentInvestigation, AgentSpecialistReport } from '@orchestrator/shared-types';
import type { InvestigationContext, InvestigationModel } from './failure-investigation-agent';
import type { AgentAuditSink } from './agent-execution-audit';
import { searchRepositoryKnowledge } from './repository-knowledge';

const SpecialistSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(z.string()).min(1).max(6),
  confidence: z.number().min(0).max(1),
});

const ActionSchema = SpecialistSchema.extend({
  proposedAction: z.enum(['create_issue', 'update_issue', 'notify_only', 'human_review']),
  risk: z.enum(['low', 'medium', 'high']),
});

const FinalSchema = z.object({
  suspectedRootCause: z.string().min(1),
  evidence: z.array(z.string()).min(1).max(8),
  recommendedAction: z.enum(['create_issue', 'update_issue', 'notify_only', 'human_review']),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
});

const specialistFormat = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['summary', 'findings', 'confidence'],
} as const;

const actionFormat = {
  type: 'object',
  properties: {
    ...specialistFormat.properties,
    proposedAction: { type: 'string', enum: ['create_issue', 'update_issue', 'notify_only', 'human_review'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: [...specialistFormat.required, 'proposedAction', 'risk'],
} as const;

const finalFormat = {
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

export interface MultiAgentGraphOptions {
  checkpointer?: BaseCheckpointSaver;
  threadId?: string;
  audit?: AgentAuditSink;
  requireApproval?: boolean;
  knowledgeSearch?: typeof searchRepositoryKnowledge;
}

const MultiAgentState = Annotation.Root({
  context: Annotation<InvestigationContext>(),
  model: Annotation<string>(),
  reports: Annotation<AgentSpecialistReport[]>(),
  toolsUsed: Annotation<string[]>(),
  sources: Annotation<Array<{ path: string; chunk: number; score: number }>>(),
  result: Annotation<AgentInvestigation | undefined>(),
  approvalStatus: Annotation<'not_required' | 'pending' | 'approved' | 'rejected'>(),
});

function failureContext(context: InvestigationContext) {
  return {
    test: context.test,
    run: {
      runId: context.run.runId,
      repository: context.run.repository,
      branch: context.run.branch,
      environment: context.run.environment,
    },
    fingerprint: context.fingerprint,
    deterministicClassification: context.deterministicClassification,
  };
}

async function recordAgent(
  audit: AgentAuditSink | undefined,
  agent: string,
  operation: () => Promise<AgentSpecialistReport>
) {
  await audit?.record({ node: `agent:${agent}`, status: 'started' });
  const report = await operation();
  await audit?.record({
    node: `agent:${agent}`,
    status: 'completed',
    details: { confidence: report.confidence, findings: report.findings.length },
  });
  return report;
}

export function createMultiAgentInvestigationGraph(
  client: InvestigationModel,
  options: MultiAgentGraphOptions = {}
) {
  const triageAgent = async (state: typeof MultiAgentState.State) => {
    const report = await recordAgent(options.audit, 'triage', async () => {
      const response = await client.chat({
        model: state.model,
        messages: [
          { role: 'system', content: 'You are the triage specialist. Analyze failure symptoms, recurrence, and deterministic classification. Do not recommend side effects. Return only schema-valid JSON and never invent evidence.' },
          { role: 'user', content: JSON.stringify({ failure: failureContext(state.context), history: state.context.history }) },
        ],
        format: specialistFormat,
        stream: false,
        think: false,
      });
      return { agent: 'triage', ...SpecialistSchema.parse(JSON.parse(response.message.content)) };
    });
    return { reports: [...state.reports, report] };
  };

  const repositoryAgent = async (state: typeof MultiAgentState.State) => {
    const query = [
      state.context.test.title,
      state.context.test.file,
      state.context.test.error?.name,
      state.context.test.error?.message,
      state.context.test.metadata?.service,
    ].filter(Boolean).join(' ');
    let matches: Awaited<ReturnType<typeof searchRepositoryKnowledge>> = [];
    if (process.env.RAG_ENABLED === 'true') {
      matches = await (options.knowledgeSearch ?? searchRepositoryKnowledge)(query, 4);
    }
    const sources = matches.map((match) => ({ path: match.sourcePath, chunk: match.chunkIndex, score: match.score }));
    const report = await recordAgent(options.audit, 'repository', async () => {
      const response = await client.chat({
        model: state.model,
        messages: [
          { role: 'system', content: 'You are the repository evidence specialist. Correlate the failure only with the supplied retrieved code and documentation. Identify likely implementation areas and evidence gaps. Do not recommend side effects. Return only schema-valid JSON.' },
          { role: 'user', content: JSON.stringify({ failure: failureContext(state.context), retrievedContext: matches }) },
        ],
        format: specialistFormat,
        stream: false,
        think: false,
      });
      return { agent: 'repository', ...SpecialistSchema.parse(JSON.parse(response.message.content)) };
    });
    return {
      reports: [...state.reports, report],
      sources,
      toolsUsed: process.env.RAG_ENABLED === 'true' ? [...state.toolsUsed, 'search_repository_context'] : state.toolsUsed,
    };
  };

  const actionAgent = async (state: typeof MultiAgentState.State) => {
    const report = await recordAgent(options.audit, 'action', async () => {
      const response = await client.chat({
        model: state.model,
        messages: [
          { role: 'system', content: 'You are the action-policy specialist. Propose the safest operational action using deterministic classification, Jira state, and specialist evidence. High-risk or insufficient evidence requires human_review. Return only schema-valid JSON.' },
          { role: 'user', content: JSON.stringify({ failure: failureContext(state.context), existingIssue: state.context.existingIssue, specialistReports: state.reports }) },
        ],
        format: actionFormat,
        stream: false,
        think: false,
      });
      const parsed = ActionSchema.parse(JSON.parse(response.message.content));
      return { agent: 'action', ...parsed };
    });
    return { reports: [...state.reports, report] };
  };

  const supervisor = async (state: typeof MultiAgentState.State) => {
    await options.audit?.record({ node: 'supervisor', status: 'started' });
    const response = await client.chat({
      model: state.model,
      messages: [
        { role: 'system', content: 'You are the supervisor. Reconcile the specialist reports into one conservative investigation. Never add facts absent from the reports. Prefer human_review when specialists conflict, action risk is high, or confidence is weak. Return only schema-valid JSON.' },
        { role: 'user', content: JSON.stringify({ deterministicClassification: state.context.deterministicClassification, specialistReports: state.reports, sources: state.sources }) },
      ],
      format: finalFormat,
      stream: false,
      think: false,
    });
    const parsed = FinalSchema.parse(JSON.parse(response.message.content));
    const result: AgentInvestigation = {
      ...parsed,
      toolsUsed: state.toolsUsed,
      model: state.model,
      sources: state.sources,
      specialistReports: state.reports,
      orchestration: 'supervisor',
    };
    await options.audit?.record({
      node: 'supervisor',
      status: 'completed',
      details: { confidence: result.confidence, recommendation: result.recommendedAction, specialists: state.reports.map((report) => report.agent) },
    });
    return { result };
  };

  const requestApproval = async (state: typeof MultiAgentState.State) => {
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
    await options.audit?.record({ node: 'request_approval', status: 'completed', details: { decision: approvalStatus, reviewer: decision.reviewer } });
    return { approvalStatus };
  };

  return new StateGraph(MultiAgentState)
    .addNode('triage_agent', triageAgent)
    .addNode('repository_agent', repositoryAgent)
    .addNode('action_agent', actionAgent)
    .addNode('supervisor', supervisor)
    .addNode('request_approval', requestApproval)
    .addEdge(START, 'triage_agent')
    .addEdge('triage_agent', 'repository_agent')
    .addEdge('repository_agent', 'action_agent')
    .addEdge('action_agent', 'supervisor')
    .addConditionalEdges('supervisor', (state) =>
      options.requireApproval && state.result?.recommendedAction === 'human_review' ? 'request_approval' : END
    )
    .addEdge('request_approval', END)
    .compile({ checkpointer: options.checkpointer });
}

export async function runMultiAgentInvestigation(
  context: InvestigationContext,
  client: InvestigationModel,
  model: string,
  options: MultiAgentGraphOptions = {}
) {
  const state = await createMultiAgentInvestigationGraph(client, options).invoke({
    context,
    model,
    reports: [],
    toolsUsed: [],
    sources: [],
    result: undefined,
    approvalStatus: 'not_required',
  }, options.threadId ? { configurable: { thread_id: options.threadId } } : undefined);
  return state.result;
}

export async function resumeMultiAgentInvestigation(input: {
  threadId: string;
  approved: boolean;
  reviewer: string;
  comment?: string;
  checkpointer: BaseCheckpointSaver;
  audit?: AgentAuditSink;
}) {
  const blockedClient: InvestigationModel = { async chat() { throw new Error('Specialist agents must not run while resuming an approval checkpoint'); } };
  const graph = createMultiAgentInvestigationGraph(blockedClient, {
    checkpointer: input.checkpointer,
    threadId: input.threadId,
    audit: input.audit,
    requireApproval: true,
  });
  const state = await graph.invoke(
    new Command({ resume: { approved: input.approved, reviewer: input.reviewer, comment: input.comment } }),
    { configurable: { thread_id: input.threadId } }
  );
  return {
    investigation: state.result,
    status: state.approvalStatus === 'approved' ? 'approved' as const : 'rejected' as const,
  };
}

export { isInterrupted };
