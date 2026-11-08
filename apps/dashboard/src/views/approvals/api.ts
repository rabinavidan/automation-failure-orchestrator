import type { ApprovalRequest } from '@orchestrator/shared-types';
import { getJson } from '../../app/data';

export async function loadPendingApprovals(signal: AbortSignal): Promise<ApprovalRequest[]> {
  const payload = await getJson<{ approvals?: ApprovalRequest[] }>(
    '/api/ingestion/api/approvals?status=pending',
    signal
  );
  return payload.approvals ?? [];
}
