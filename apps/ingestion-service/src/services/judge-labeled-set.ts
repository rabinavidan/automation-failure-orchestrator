import type { AgentInvestigation } from '@orchestrator/shared-types';
import type { LabeledJudgeExample } from './agent-judge';

const base: Omit<AgentInvestigation, 'suspectedRootCause' | 'evidence' | 'explanation'> = {
  recommendedAction: 'notify_only',
  confidence: 0.8,
  toolsUsed: ['get_failure_history'],
  model: 'qwen3:4b',
};

export const JUDGE_LABELED_SET: LabeledJudgeExample[] = [
  {
    id: 'grounded-payment-gateway-500',
    humanVerdict: 'pass',
    investigation: {
      ...base,
      suspectedRootCause: 'External payment gateway returned HTTP 500 during checkout',
      evidence: [
        'Server error body reports "payment gateway unavailable"',
        'Recent pass/fail history shows intermittent failures on the same test',
      ],
      explanation:
        'The 500 response and intermittent history point to a transient dependency outage rather than a code regression.',
    },
  },
  {
    id: 'grounded-webhook-secret-mismatch',
    humanVerdict: 'pass',
    investigation: {
      ...base,
      recommendedAction: 'human_review',
      suspectedRootCause: 'Webhook signature comparison uses non-timing-safe equality',
      evidence: [
        'middleware/webhook-secret.ts compares secrets with ===',
        'Test expects a 401 for a mismatched signature and receives 401, but a timing side-channel exists',
      ],
      explanation:
        'The functional test passes, but the comparison method is a security-sensitive pattern that warrants human review before shipping.',
    },
  },
  {
    id: 'grounded-selector-rename',
    humanVerdict: 'pass',
    investigation: {
      ...base,
      suspectedRootCause: 'Test selector [data-testid="submit"] no longer exists after a UI rename',
      evidence: [
        'Repository diff shows the submit button testid changed to "checkout-submit" in the last commit',
        'Playwright error is a selector-not-found timeout, not an assertion failure',
      ],
      explanation:
        'The application code did not regress; the automation selector is stale relative to a recent, intentional UI change.',
    },
  },
  {
    id: 'ungrounded-generic-flaky',
    humanVerdict: 'fail',
    investigation: {
      ...base,
      suspectedRootCause: 'The test is flaky',
      evidence: ['It failed this time'],
      explanation: 'Probably just flaky, should be fine on retry.',
    },
  },
  {
    id: 'ungrounded-unsupported-certainty',
    humanVerdict: 'fail',
    investigation: {
      ...base,
      confidence: 0.95,
      suspectedRootCause: 'Definitely a database connection pool exhaustion bug',
      evidence: ['The request timed out'],
      explanation:
        'This is certainly caused by connection pool exhaustion and needs an immediate fix.',
    },
  },
  {
    id: 'ungrounded-evidence-mismatch',
    humanVerdict: 'fail',
    investigation: {
      ...base,
      suspectedRootCause: 'Frontend rendering bug in the checkout summary component',
      evidence: ['The API returned a 503 Service Unavailable from the inventory service'],
      explanation:
        'The evidence describes a backend dependency outage, but the stated root cause blames the frontend, so the two do not agree.',
    },
  },
];
