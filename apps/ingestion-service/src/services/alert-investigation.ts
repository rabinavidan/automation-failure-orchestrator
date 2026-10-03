import type {
  AlertInvestigationOutcome,
  AlertProcessingResult,
  AlertTriage,
  EnrichmentResponse,
  SecurityAlert,
  SocEvaluationResult,
  SocInvestigation,
} from '@orchestrator/shared-types';
import { query } from '../db/client';
import {
  createDatabaseAuditSink,
  finishAgentExecution,
  startAlertAgentExecution,
} from './agent-execution-audit';
import { createDatabaseTelemetrySink } from './agent-telemetry';
import { createOllamaClient } from './failure-investigation-agent';
import type { InvestigationModel } from './failure-investigation-agent';
import { evaluateSocInvestigation } from './soc-agent-evaluation';
import { SOC_GRAPH_VERSION, runSocInvestigation } from './soc-investigation';
import { loadRunbooks, selectRunbooks } from './soc-runbooks';
import { getInvestigationQueue } from './investigation-queue';
import type { InvestigationQueue } from './investigation-queue';

/** LLM time is spent only where a human will act: confirmed threats and the analyst queue. */
const INVESTIGATED_DISPOSITIONS = new Set(['true_positive', 'needs_investigation']);

export interface AlertInvestigationInput {
  alert: SecurityAlert;
  result: AlertProcessingResult;
  triage: AlertTriage;
  enrichment: EnrichmentResponse | null;
}

export interface AlertInvestigationDeps {
  client: InvestigationModel;
  model: string;
}

export function threadIdFor(alertId: string): string {
  return `alert:${alertId}`;
}

/**
 * Queues an advisory investigation and returns immediately: SIEM webhooks must not
 * wait on model latency. With INVESTIGATION_QUEUE=sqs the alert id goes to SQS and the
 * investigation worker runs it (durable, retried, dead-lettered); otherwise it runs
 * in-process after the response, which a restart can lose.
 */
export function scheduleAlertInvestigation(
  input: AlertInvestigationInput | null,
  deps?: AlertInvestigationDeps,
  schedule: (task: () => void) => void = setImmediate,
  queue: InvestigationQueue | null = getInvestigationQueue()
): AlertInvestigationOutcome {
  if (!input) return { status: 'not_applicable' };
  if (process.env.AI_ENABLED !== 'true') return { status: 'disabled' };
  if (!INVESTIGATED_DISPOSITIONS.has(input.triage.disposition)) {
    return { status: 'not_applicable' };
  }

  const threadId = threadIdFor(input.alert.alertId);
  const runInProcess = () =>
    schedule(() => {
      runAlertInvestigation(input, deps).catch((err) =>
        console.error(`[SOC Agent] ${threadId} crashed:`, err instanceof Error ? err.name : err)
      );
    });

  if (queue) {
    // Durable path: the worker loads everything it needs from the database by alert id.
    queue.enqueue(input.alert.alertId).catch((err) => {
      console.error(
        `[SOC Agent] enqueue failed for ${threadId}; running in-process instead:`,
        err instanceof Error ? err.name : err
      );
      runInProcess();
    });
    return { status: 'queued', threadId, queue: queue.kind };
  }

  runInProcess();
  return { status: 'queued', threadId, queue: 'in_process' };
}

/** Rebuilds an investigation input from the persisted alert (used by the queue worker). */
export async function loadInvestigationInput(alertId: string): Promise<{
  input: AlertInvestigationInput | null;
  alreadyCompleted: boolean;
}> {
  const rows = await query<{
    alert: SecurityAlert;
    triage: AlertTriage | null;
    enrichment: EnrichmentResponse | null;
    fingerprint: string;
    status: AlertProcessingResult['status'];
    ai_investigation_status: string | null;
  }>(
    `SELECT alert, triage, enrichment, fingerprint, status, ai_investigation_status
     FROM security_alerts WHERE alert_id = $1`,
    [alertId]
  );
  const row = rows[0];
  if (!row?.triage) return { input: null, alreadyCompleted: false };
  return {
    alreadyCompleted: row.ai_investigation_status === 'completed',
    input: {
      alert: row.alert,
      triage: row.triage,
      enrichment: row.enrichment,
      result: {
        alertId,
        fingerprint: row.fingerprint,
        fingerprintLabel: '',
        status: row.status,
        occurrenceCount: 1,
        suppressedCount: 0,
        firstSeenAt: '',
        lastSeenAt: '',
      },
    },
  };
}

export async function runAlertInvestigation(
  input: AlertInvestigationInput,
  deps: AlertInvestigationDeps = createOllamaClient()
): Promise<{
  status: 'completed' | 'failed';
  investigation?: SocInvestigation;
  evaluation?: SocEvaluationResult;
}> {
  const { alert, result, triage, enrichment } = input;
  const threadId = threadIdFor(alert.alertId);
  const runbooks = selectRunbooks(triage.mitre.techniques, loadRunbooks());

  try {
    await startAlertAgentExecution({
      threadId,
      alertId: alert.alertId,
      fingerprint: result.fingerprint,
      model: deps.model,
      graphVersion: SOC_GRAPH_VERSION,
    });
    await setStatus(alert.alertId, 'running');

    const investigation = await runSocInvestigation(
      { alert, triage, enrichment, runbooks },
      deps.client,
      deps.model,
      {
        threadId,
        audit: createDatabaseAuditSink(threadId),
        telemetry: createDatabaseTelemetrySink(threadId),
      }
    );
    if (!investigation) throw new Error('graph finished without a result');

    const evaluation = evaluateSocInvestigation(investigation, {
      alert,
      triage,
      enrichment,
      suppliedRunbooks: runbooks.map((rb) => rb.file),
    });
    await query(
      `UPDATE security_alerts
       SET ai_investigation_status = 'completed', ai_investigation = $2, ai_evaluation = $3,
           ai_investigated_at = NOW()
       WHERE alert_id = $1`,
      [alert.alertId, JSON.stringify(investigation), JSON.stringify(evaluation)]
    );
    await finishAgentExecution(threadId, 'completed', investigation);
    return { status: 'completed', investigation, evaluation };
  } catch (err) {
    // Fail-open: the deterministic triage already stands on its own.
    console.warn(
      `[SOC Agent] ${threadId} unavailable; deterministic triage stands:`,
      err instanceof Error ? err.name : err
    );
    await setStatus(alert.alertId, 'failed').catch(() => undefined);
    await finishAgentExecution(threadId, 'failed').catch(() => undefined);
    return { status: 'failed' };
  }
}

async function setStatus(alertId: string, status: 'running' | 'failed'): Promise<void> {
  await query('UPDATE security_alerts SET ai_investigation_status = $2 WHERE alert_id = $1', [
    alertId,
    status,
  ]);
}
