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
  EnrichmentVerdictSchema,
  EnrichmentSummarySchema,
  EnrichmentResponseSchema,
  TriagePolicySchema,
  TriagePolicyEntrySchema,
  TriageDispositionSchema,
  TriagePrioritySchema,
  TriageActionSchema,
  ResponseActionTypeSchema,
  PlaybookStepSchema,
  PlaybookSchema,
  ResponseActionStatusSchema,
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
export type EnrichmentVerdict = z.infer<typeof EnrichmentVerdictSchema>;
export type EnrichmentSummary = z.infer<typeof EnrichmentSummarySchema>;
export type EnrichmentResponse = z.infer<typeof EnrichmentResponseSchema>;

/**
 * Enrichment runs only for `new` alerts (suppressed repeats and duplicate
 * deliveries never spend threat-intel quota) and is fail-open: an unavailable
 * enrichment service never blocks ingestion.
 */
export interface AlertEnrichmentOutcome {
  status: 'enriched' | 'failed' | 'disabled' | 'not_applicable';
  summary?: EnrichmentSummary;
  error?: string;
}

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
  enrichment?: AlertEnrichmentOutcome;
  triage?: AlertTriage;
  investigation?: AlertInvestigationOutcome;
  response?: AlertResponseOutcome;
}

export type TriagePolicy = z.infer<typeof TriagePolicySchema>;
export type TriagePolicyEntry = z.infer<typeof TriagePolicyEntrySchema>;
export type TriageDisposition = z.infer<typeof TriageDispositionSchema>;
export type TriagePriority = z.infer<typeof TriagePrioritySchema>;
export type TriageAction = z.infer<typeof TriageActionSchema>;

export interface TriageInput {
  alert: SecurityAlert;
  ingestionStatus: 'new' | 'suppressed';
  /** Full enrichment response for `new` alerts, when enrichment succeeded. */
  enrichment?: EnrichmentResponse | null;
  /** Times this fingerprint has been seen, including this alert. */
  occurrenceCount: number;
  policy: TriagePolicy;
  now?: Date;
}

/**
 * Deterministic, explainable triage decision. `reasons` is the evidence trail
 * an analyst (or the M4 agents) reads; `matchedPolicyId` names the policy
 * entry that decided an allowlist/known-benign outcome.
 */
export interface AlertTriage {
  disposition: TriageDisposition;
  recommendedAction: TriageAction;
  priority: TriagePriority;
  riskScore: number;
  reasons: string[];
  matchedPolicyId?: string;
  mitre: {
    tactics: string[];
    techniques: string[];
    /** True when techniques were inferred from the rule name rather than supplied by the SIEM. */
    inferred: boolean;
  };
  policyVersion: string;
}

// ---------------------------------------------------------------------------
// SOC AI investigation (M4): advisory multi-agent output
// ---------------------------------------------------------------------------

export type SocResponseRecommendation = 'contain' | 'investigate' | 'monitor' | 'close';

export interface SocSpecialistReport {
  agent: 'triage_analyst' | 'threat_intel' | 'response_planner';
  summary: string;
  findings: string[];
  confidence: number;
  proposedResponse?: SocResponseRecommendation;
  risk?: 'low' | 'medium' | 'high';
}

/**
 * Advisory only: the deterministic `AlertTriage` disposition is never changed by
 * the agents. `requiresHumanApproval` is set by code (not the model) whenever the
 * agents recommend containment or disagree with the deterministic triage.
 */
export interface SocInvestigation {
  summary: string;
  attackNarrative: string;
  evidence: string[];
  recommendedResponse: SocResponseRecommendation;
  responseSteps: string[];
  confidence: number;
  explanation: string;
  citedRunbooks: string[];
  requiresHumanApproval: boolean;
  conflictsWithTriage: boolean;
  specialistReports: SocSpecialistReport[];
  model: string;
  graphVersion: string;
}

export interface SocEvaluationResult {
  passed: boolean;
  score: number;
  metrics: {
    schemaComplete: boolean;
    specialistCoverage: boolean;
    iocGrounded: boolean;
    runbookGrounded: boolean;
    safeContainmentPolicy: boolean;
    triageRespected: boolean;
    confidenceCalibrated: boolean;
  };
  failures: string[];
  ungroundedIndicators: string[];
}

export interface AlertInvestigationOutcome {
  status: 'queued' | 'disabled' | 'not_applicable';
  threadId?: string;
}

// ---------------------------------------------------------------------------
// Response playbooks (M5)
// ---------------------------------------------------------------------------

export type ResponseActionType = z.infer<typeof ResponseActionTypeSchema>;
export type PlaybookStep = z.infer<typeof PlaybookStepSchema>;
export type Playbook = z.infer<typeof PlaybookSchema>;
export type ResponseActionStatus = z.infer<typeof ResponseActionStatusSchema>;

export interface ResponseActionSummary {
  id: string;
  playbookId: string;
  stepId: string;
  action: ResponseActionType;
  target: string | null;
  status: ResponseActionStatus;
  detail?: string;
}

export interface AlertResponseOutcome {
  playbooks: string[];
  actions: ResponseActionSummary[];
}
