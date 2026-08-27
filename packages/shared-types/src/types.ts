import { z } from 'zod';
import {
  TestErrorSchema,
  TestMetadataSchema,
  TestArtifactsSchema,
  TestResultSchema,
  SummarySchema,
  WebhookPayloadSchema,
} from './schemas';

export type TestError = z.infer<typeof TestErrorSchema>;
export type TestMetadata = z.infer<typeof TestMetadataSchema>;
export type TestArtifacts = z.infer<typeof TestArtifactsSchema>;
export type TestResult = z.infer<typeof TestResultSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

export enum FailureClassification {
  KnownBug = 'known_bug',
  NewRegression = 'new_regression',
  FlakyTest = 'flaky',
  InfrastructureFailure = 'infrastructure',
  AutomationFailure = 'automation_failure',
  PossiblyFixed = 'possibly_fixed',
}

export interface ProcessingResult {
  runId: string;
  processed: number;
  skipped: number;
  failures: FailureSummary[];
  duplicateRun?: boolean;
}

export interface FailureSummary {
  testId: string;
  title: string;
  fingerprint: string;
  classification: FailureClassification;
  jiraKey?: string;
  slackSent?: boolean;
  agentInvestigation?: AgentInvestigation;
  approval?: {
    threadId: string;
    status: 'pending' | 'approved' | 'rejected';
  };
}

export interface AgentInvestigation {
  suspectedRootCause: string;
  evidence: string[];
  recommendedAction: 'create_issue' | 'update_issue' | 'notify_only' | 'human_review';
  confidence: number;
  explanation: string;
  toolsUsed: string[];
  model: string;
}

export interface FingerprintInput {
  testId: string;
  service?: string;
  errorName: string;
  errorMessage: string;
  endpoint?: string;
}

export interface FailureHistory {
  fingerprint: string;
  runCount: number;
  lastStatuses: Array<'passed' | 'failed' | 'skipped'>;
  consecutivePasses: number;
  jiraIssueKey?: string;
}

export interface ClassifyInput {
  test: TestResult;
  failureHistory?: FailureHistory;
  existingJiraIssue?: string;
}
