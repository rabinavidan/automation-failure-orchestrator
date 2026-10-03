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
 * wait on model latency. The investigation runs in-process after the response;
 * a restart loses queued work (a durable queue is part of the AWS milestone).
 */
export function scheduleAlertInvestigation(
  input: AlertInvestigationInput | null,
  deps?: AlertInvestigationDeps,
  schedule: (task: () => void) => void = setImmediate
): AlertInvestigationOutcome {
  if (!input) return { status: 'not_applicable' };
  if (process.env.AI_ENABLED !== 'true') return { status: 'disabled' };
  if (!INVESTIGATED_DISPOSITIONS.has(input.triage.disposition)) {
    return { status: 'not_applicable' };
  }

  const threadId = threadIdFor(input.alert.alertId);
  schedule(() => {
    runAlertInvestigation(input, deps).catch((err) =>
      console.error(`[SOC Agent] ${threadId} crashed:`, err instanceof Error ? err.name : err)
    );
  });
  return { status: 'queued', threadId };
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
