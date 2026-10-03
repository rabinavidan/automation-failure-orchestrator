import { z } from 'zod';
import {
  TestErrorSchema,
  TestMetadataSchema,
  TestArtifactsSchema,
  TestResultSchema,
  SummarySchema,
  WebhookPayloadSchema,
} from './schemas';
import {
  SecuritySeveritySchema,
  IndicatorTypeSchema,
  IndicatorSchema,
  MitreAttackSchema,
  AlertSourceSchema,
  SecurityAlertSchema,
  SplunkAlertWebhookSchema,
} from './security';

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
  sources?: Array<{
    path: string;
    chunk: number;
    score: number;
  }>;
  orchestration?: 'single_agent' | 'supervisor';
  specialistReports?: AgentSpecialistReport[];
}

export interface AgentSpecialistReport {
  agent: string;
  summary: string;
  findings: string[];
  confidence: number;
  proposedAction?: 'create_issue' | 'update_issue' | 'notify_only' | 'human_review';
  risk?: 'low' | 'medium' | 'high';
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

// ---------------------------------------------------------------------------
// Security alert (SOC automation) types
// ---------------------------------------------------------------------------

export type SecuritySeverity = z.infer<typeof SecuritySeveritySchema>;
export type IndicatorType = z.infer<typeof IndicatorTypeSchema>;
export type Indicator = z.infer<typeof IndicatorSchema>;
export type MitreAttack = z.infer<typeof MitreAttackSchema>;
export type AlertSource = z.infer<typeof AlertSourceSchema>;
export type SecurityAlert = z.infer<typeof SecurityAlertSchema>;
export type SplunkAlertWebhook = z.infer<typeof SplunkAlertWebhookSchema>;

export interface AlertFingerprintInput {
  vendor: AlertSource['vendor'];
  ruleId: string;
  host?: string;
  user?: string;
  indicators: Indicator[];
}

/**
 * - `new`: first sighting, or outside the suppression window — actionable.
 * - `suppressed`: same fingerprint seen within the suppression window — counted, not actioned.
 * - `duplicate_delivery`: same alertId already ingested (webhook retry) — no-op.
 */
export type AlertIngestionStatus = 'new' | 'suppressed' | 'duplicate_delivery';

export interface AlertProcessingResult {
  alertId: string;
  fingerprint: string;
  fingerprintLabel: string;
  status: AlertIngestionStatus;
  occurrenceCount: number;
  suppressedCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}
