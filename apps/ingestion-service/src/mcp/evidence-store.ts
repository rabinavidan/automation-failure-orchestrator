import type { FailureHistory } from '@orchestrator/shared-types';
import { fingerprintLabel } from '@orchestrator/fingerprint-engine';
import { query } from '../db/client';
import { searchByLabel, type JiraIssue } from '../services/jira-adapter';
import { searchRepositoryKnowledge, type KnowledgeMatch } from '../services/repository-knowledge';

/** Read-only evidence lookups. Every method is already scoped by the caller (the MCP server). */
export interface EvidenceStore {
  getRun(runId: string): Promise<Record<string, unknown> | null>;
  getTestResult(runId: string, fingerprint: string): Promise<Record<string, unknown> | null>;
  getFailureHistory(fingerprint: string): Promise<FailureHistory | null>;
  getRelatedIssue(fingerprint: string): Promise<JiraIssue | null>;
  searchRepository(searchText: string, topK: number): Promise<KnowledgeMatch[] | null>;
}

export function createDatabaseEvidenceStore(): EvidenceStore {
  return {
    async getRun(runId) {
      const rows = await query<Record<string, unknown>>(
        `SELECT run_id, repository, branch, commit_sha, environment, started_at, finished_at, summary
         FROM test_runs WHERE run_id = $1`,
        [runId]
      );
      return rows[0] ?? null;
    },
    async getTestResult(runId, fingerprint) {
      const rows = await query<Record<string, unknown>>(
        `SELECT test_id, title, suite, file, status, retry, classification, error_name, error_message
         FROM test_results WHERE run_id = $1 AND fingerprint = $2 ORDER BY id DESC LIMIT 1`,
        [runId, fingerprint]
      );
      return rows[0] ?? null;
    },
    async getFailureHistory(fingerprint) {
      const rows = await query<{
        fingerprint: string;
        run_count: number;
        last_statuses: Array<'passed' | 'failed' | 'skipped'>;
        consecutive_passes: number;
        jira_issue_key: string | null;
      }>(
        `SELECT fingerprint, run_count, last_statuses, consecutive_passes, jira_issue_key
         FROM failure_history WHERE fingerprint = $1`,
        [fingerprint]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        fingerprint: row.fingerprint,
        runCount: row.run_count,
        lastStatuses: row.last_statuses,
        consecutivePasses: row.consecutive_passes,
        ...(row.jira_issue_key ? { jiraIssueKey: row.jira_issue_key } : {}),
      };
    },
    getRelatedIssue(fingerprint) {
      return searchByLabel(fingerprintLabel(fingerprint));
    },
    async searchRepository(searchText, topK) {
      if (process.env.RAG_ENABLED !== 'true') return null;
      return searchRepositoryKnowledge(searchText, topK);
    },
  };
}
