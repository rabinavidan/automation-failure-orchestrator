import type {
  AlertResponseOutcome,
  AlertTriage,
  Playbook,
  PlaybookStep,
  ResponseActionStatus,
  ResponseActionSummary,
  ResponseActionType,
  SecurityAlert,
  TriagePolicy,
} from '@orchestrator/shared-types';
import { query } from '../db/client';
import { getTriagePolicy } from './alert-triage';
import { getPlaybooks, selectPlaybooks } from './playbooks';
import { executeAction, guardAction, isReversible, rollbackAction } from './response-actions';
import type { ActionDeps } from './response-actions';

const SYSTEM_ACTOR = 'system:playbook-engine';

export interface ResponseActionRow {
  id: string;
  alert_id: string;
  playbook_id: string;
  playbook_version: number;
  step_id: string;
  action: ResponseActionType;
  description: string;
  target_type: string | null;
  target_value: string;
  approval_required: boolean;
  status: ResponseActionStatus;
  detail: string | null;
  reviewer: string | null;
}

interface ResponseContext {
  alert: SecurityAlert;
  triage: AlertTriage;
  fingerprint: string;
}

const defaultDeps: ActionDeps = { fetch };

/** Resolve a step's target(s) from the alert's indicators. Steps without a target run once. */
export function resolveTargets(step: PlaybookStep, alert: SecurityAlert): string[] {
  if (!step.target) return [''];
  const values = alert.indicators
    .filter(
      (i) =>
        i.type === step.target!.indicator && (!step.target!.role || i.role === step.target!.role)
    )
    .map((i) => i.value.trim());
  if (step.target.indicator === 'host' && values.length === 0 && alert.host)
    values.push(alert.host);
  return [...new Set(values)];
}

async function recordEvent(
  actionId: string,
  event: string,
  actor: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  await query(
    `INSERT INTO response_action_events (action_id, event, actor, details) VALUES ($1, $2, $3, $4::jsonb)`,
    [actionId, event, actor, JSON.stringify(details)]
  );
}

async function setResult(
  id: string,
  status: ResponseActionStatus,
  detail: string,
  executed: boolean
): Promise<void> {
  await query(
    `UPDATE response_actions SET status = $2, detail = $3,
       executed_at = CASE WHEN $4 THEN NOW() ELSE executed_at END
     WHERE id = $1`,
    [id, status, detail, executed]
  );
}

async function execute(
  row: Pick<ResponseActionRow, 'id' | 'action' | 'target_value' | 'description'>,
  ctx: ResponseContext,
  actor: string,
  policy: TriagePolicy,
  deps: ActionDeps
): Promise<{ status: ResponseActionStatus; detail: string }> {
  // Re-check guards at execution time: an approval granted yesterday must not
  // block an IP that was allowlisted this morning.
  const blocked = guardAction(row.action, row.target_value, policy);
  if (blocked) {
    await setResult(row.id, 'blocked_by_guard', blocked, false);
    await recordEvent(row.id, 'blocked_by_guard', actor, { reason: blocked });
    return { status: 'blocked_by_guard', detail: blocked };
  }
  try {
    const detail = await executeAction(
      {
        action: row.action,
        targetValue: row.target_value,
        alert: ctx.alert,
        triage: ctx.triage,
        fingerprint: ctx.fingerprint,
        actor,
        reason: `${row.description} (alert ${ctx.alert.alertId})`,
      },
      deps
    );
    await setResult(row.id, 'succeeded', detail, true);
    await recordEvent(row.id, 'executed', actor, { detail });
    return { status: 'succeeded', detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'action failed';
    await setResult(row.id, 'failed', detail, true);
    await recordEvent(row.id, 'failed', actor, { error: detail });
    return { status: 'failed', detail };
  }
}

/**
 * Plans and starts the response for a triaged alert. Low-risk steps (tickets,
 * notifications) run immediately; containment is queued for human approval.
 * Re-delivery is idempotent: existing (alert, playbook, step, target) rows are reused.
 */
export async function runResponsePlaybooks(
  ctx: ResponseContext,
  deps: ActionDeps = defaultDeps,
  playbooks: Playbook[] = getPlaybooks().playbooks,
  policy: TriagePolicy = getTriagePolicy().policy
): Promise<AlertResponseOutcome> {
  const selected = selectPlaybooks(playbooks, ctx.triage);
  const actions: ResponseActionSummary[] = [];

  for (const playbook of selected) {
    for (const step of playbook.steps) {
      for (const target of resolveTargets(step, ctx.alert)) {
        const guard =
          step.approval === 'required' ? guardAction(step.action, target, policy) : null;
        const initial: ResponseActionStatus = guard
          ? 'blocked_by_guard'
          : step.approval === 'required'
            ? 'pending_approval'
            : 'approved';

        const inserted = await query<{ id: string }>(
          `INSERT INTO response_actions
             (alert_id, playbook_id, playbook_version, step_id, action, description,
              target_type, target_value, approval_required, status, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (alert_id, playbook_id, step_id, target_value) DO NOTHING
           RETURNING id`,
          [
            ctx.alert.alertId,
            playbook.id,
            playbook.version,
            step.id,
            step.action,
            step.description,
            step.target?.indicator ?? null,
            target,
            step.approval === 'required',
            initial,
            guard,
          ]
        );
        const id = inserted[0]?.id;
        if (!id) continue; // already planned by an earlier delivery

        await recordEvent(id, 'planned', SYSTEM_ACTOR, {
          playbook: playbook.id,
          version: playbook.version,
          ...(guard ? { guard } : {}),
        });

        let status: ResponseActionStatus = initial;
        let detail = guard ?? undefined;
        if (initial === 'approved') {
          ({ status, detail } = await execute(
            { id, action: step.action, target_value: target, description: step.description },
            ctx,
            SYSTEM_ACTOR,
            policy,
            deps
          ));
        }
        actions.push({
          id,
          playbookId: playbook.id,
          stepId: step.id,
          action: step.action,
          target: target || null,
          status,
          ...(detail ? { detail } : {}),
        });
      }
    }
  }

  return { playbooks: selected.map((p) => p.id), actions };
}

export async function getResponseAction(id: string): Promise<ResponseActionRow | null> {
  const rows = await query<ResponseActionRow>('SELECT * FROM response_actions WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function loadContext(alertId: string): Promise<ResponseContext | null> {
  const rows = await query<{ alert: SecurityAlert; triage: AlertTriage; fingerprint: string }>(
    'SELECT alert, triage, fingerprint FROM security_alerts WHERE alert_id = $1',
    [alertId]
  );
  const row = rows[0];
  return row?.triage
    ? { alert: row.alert, triage: row.triage, fingerprint: row.fingerprint }
    : null;
}

export type DecisionOutcome =
  | { ok: true; status: ResponseActionStatus; detail?: string }
  | { ok: false; code: 404 | 409; error: string };

/** Approve or reject a pending containment action. The status claim is atomic, so two
 * reviewers clicking at once cannot execute an action twice. */
export async function decideResponseAction(
  input: { id: string; decision: 'approved' | 'rejected'; reviewer: string; comment?: string },
  deps: ActionDeps = defaultDeps,
  policy: TriagePolicy = getTriagePolicy().policy
): Promise<DecisionOutcome> {
  const claimed = await query<ResponseActionRow>(
    `UPDATE response_actions
     SET status = $2, reviewer = $3, review_comment = $4, decided_at = NOW()
     WHERE id = $1 AND status = 'pending_approval'
     RETURNING *`,
    [input.id, input.decision, input.reviewer, input.comment ?? null]
  );
  const row = claimed[0];
  if (!row) {
    const existing = await getResponseAction(input.id);
    return existing
      ? { ok: false, code: 409, error: `action is ${existing.status}, not pending_approval` }
      : { ok: false, code: 404, error: 'response action not found' };
  }

  const actor = `human:${input.reviewer}`;
  await recordEvent(row.id, input.decision, actor, { comment: input.comment });
  if (input.decision === 'rejected') return { ok: true, status: 'rejected' };

  const ctx = await loadContext(row.alert_id);
  if (!ctx) {
    await setResult(row.id, 'failed', 'alert context missing', false);
    return { ok: true, status: 'failed', detail: 'alert context missing' };
  }
  const result = await execute(row, ctx, actor, policy, deps);
  return { ok: true, ...result };
}

/** Undo a reversible action (release a host, unblock an IP). */
export async function rollbackResponseAction(
  input: { id: string; reviewer: string; reason: string },
  deps: ActionDeps = defaultDeps
): Promise<DecisionOutcome> {
  const existing = await getResponseAction(input.id);
  if (!existing) return { ok: false, code: 404, error: 'response action not found' };
  if (!isReversible(existing.action)) {
    return { ok: false, code: 409, error: `${existing.action} is not reversible` };
  }

  const claimed = await query<ResponseActionRow>(
    `UPDATE response_actions SET status = 'rolled_back', rolled_back_by = $2, rolled_back_at = NOW()
     WHERE id = $1 AND status = 'succeeded' RETURNING *`,
    [input.id, input.reviewer]
  );
  const row = claimed[0];
  if (!row) return { ok: false, code: 409, error: `action is ${existing.status}, not succeeded` };

  const actor = `human:${input.reviewer}`;
  try {
    const detail = await rollbackAction(row.action, row.target_value, actor, deps);
    await query('UPDATE response_actions SET detail = $2 WHERE id = $1', [row.id, detail]);
    await recordEvent(row.id, 'rolled_back', actor, { reason: input.reason, detail });
    return { ok: true, status: 'rolled_back', detail };
  } catch (err) {
    // Restore the claim so the rollback can be retried; the action is still in effect.
    await query(
      `UPDATE response_actions SET status = 'succeeded', rolled_back_by = NULL, rolled_back_at = NULL
       WHERE id = $1`,
      [row.id]
    );
    const error = err instanceof Error ? err.message : 'rollback failed';
    await recordEvent(row.id, 'rollback_failed', actor, { reason: input.reason, error });
    return { ok: true, status: 'succeeded', detail: `rollback failed: ${error}` };
  }
}
