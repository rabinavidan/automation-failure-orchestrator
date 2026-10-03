import type {
  AlertTriage,
  EnrichmentResponse,
  SecuritySeverity,
  TriageAction,
  TriageDisposition,
  TriageInput,
  TriagePriority,
} from '@orchestrator/shared-types';
import {
  HIGH_CONFIDENCE_TECHNIQUES,
  HIGH_IMPACT_TACTICS,
  parentTechnique,
  resolveMitre,
} from './mitre';
import { findMatchingEntry } from './policy-match';

const SEVERITY_BASE: Record<SecuritySeverity, number> = {
  informational: 10,
  low: 25,
  medium: 50,
  high: 70,
  critical: 90,
};

const ACTION: Record<TriageDisposition, TriageAction> = {
  false_positive: 'close',
  duplicate: 'suppress',
  true_positive: 'escalate',
  benign_true_positive: 'close',
  needs_investigation: 'investigate',
};

export function priorityFor(score: number): TriagePriority {
  if (score >= 85) return 'P1';
  if (score >= 65) return 'P2';
  if (score >= 40) return 'P3';
  return 'P4';
}

/** Severity, threat intel, kill-chain stage and recurrence, capped at 100. */
export function riskScore(input: {
  severity: SecuritySeverity;
  enrichmentVerdict?: string;
  tactics: string[];
  occurrenceCount: number;
}): { score: number; factors: string[] } {
  const factors = [`severity ${input.severity} (+${SEVERITY_BASE[input.severity]})`];
  let score = SEVERITY_BASE[input.severity];

  if (input.enrichmentVerdict === 'malicious') {
    score += 20;
    factors.push('threat intel malicious (+20)');
  } else if (input.enrichmentVerdict === 'suspicious') {
    score += 10;
    factors.push('threat intel suspicious (+10)');
  }

  const lateStage = input.tactics.filter((t) => HIGH_IMPACT_TACTICS.has(t));
  if (lateStage.length > 0) {
    score += 10;
    factors.push(`late kill-chain tactic: ${lateStage.join(', ')} (+10)`);
  }

  if (input.occurrenceCount >= 20) {
    score += 10;
    factors.push(`recurring: seen ${input.occurrenceCount} times (+10)`);
  } else if (input.occurrenceCount >= 5) {
    score += 5;
    factors.push(`recurring: seen ${input.occurrenceCount} times (+5)`);
  }

  return { score: Math.min(100, score), factors };
}

function maliciousIndicators(enrichment: EnrichmentResponse | null | undefined): string[] {
  if (!enrichment) return [];
  return enrichment.enrichments
    .filter((e) => e.verdict === 'malicious')
    .map((e) => {
      const providers = e.results
        .filter((r) => r.verdict === 'malicious')
        .map((r) => `${r.provider} ${r.score}`)
        .join(', ');
      return `${e.indicator.type} ${e.normalizedValue} (${providers})`;
    });
}

/**
 * Deterministic SOC triage. Strict priority chain, first match wins:
 *
 *   1. false_positive        allowlist policy match (e.g. our own vulnerability scanner)
 *   2. duplicate             fingerprint suppressed within the dedup window
 *   3. true_positive         malicious threat intel, or a high-confidence ATT&CK
 *                            technique at critical severity
 *   4. benign_true_positive  known-benign policy match (sanctioned activity)
 *   5. needs_investigation   everything else, ranked by risk score
 *
 * Malicious intel deliberately outranks known-benign policy: a sanctioned
 * account talking to a known-bad IP is escalated, not closed.
 */
export function triageAlert(input: TriageInput): AlertTriage {
  const now = input.now ?? new Date();
  const { alert, policy } = input;
  const mitre = resolveMitre(alert);
  const enrichmentVerdict = input.enrichment?.summary.verdict;
  const risk = riskScore({
    severity: alert.severity,
    enrichmentVerdict,
    tactics: mitre.tactics,
    occurrenceCount: input.occurrenceCount,
  });

  const decide = (
    disposition: TriageDisposition,
    reasons: string[],
    extra: { matchedPolicyId?: string; score?: number; priority?: TriagePriority } = {}
  ): AlertTriage => {
    const score = extra.score ?? risk.score;
    return {
      disposition,
      recommendedAction: ACTION[disposition],
      priority: extra.priority ?? priorityFor(score),
      riskScore: score,
      reasons,
      ...(extra.matchedPolicyId ? { matchedPolicyId: extra.matchedPolicyId } : {}),
      mitre,
      policyVersion: policy.version,
    };
  };

  const allow = findMatchingEntry(policy.allowlist, alert, now);
  if (allow) {
    return decide(
      'false_positive',
      [`Allowlisted by policy "${allow.id}": ${allow.description} (owner ${allow.owner})`],
      { matchedPolicyId: allow.id, score: 0, priority: 'P4' }
    );
  }

  if (input.ingestionStatus === 'suppressed') {
    return decide(
      'duplicate',
      [
        `Same detection already seen within the suppression window (${input.occurrenceCount} occurrences); handled by the original alert`,
      ],
      { priority: 'P4' }
    );
  }

  const malicious = maliciousIndicators(input.enrichment);
  const highConfidence = mitre.techniques.filter((t) =>
    HIGH_CONFIDENCE_TECHNIQUES.has(parentTechnique(t))
  );
  if (malicious.length > 0 || (alert.severity === 'critical' && highConfidence.length > 0)) {
    const reasons = [
      ...malicious.map((m) => `Threat intel: ${m} is malicious`),
      ...(alert.severity === 'critical' && highConfidence.length > 0
        ? [`Critical detection of high-confidence ATT&CK technique ${highConfidence.join(', ')}`]
        : []),
      ...risk.factors,
    ];
    // A confirmed threat is never queued behind routine work.
    const priority = risk.score >= 85 ? 'P1' : 'P2';
    return decide('true_positive', reasons, { priority });
  }

  const benign = findMatchingEntry(policy.knownBenign, alert, now);
  if (benign) {
    return decide(
      'benign_true_positive',
      [`Known benign by policy "${benign.id}": ${benign.description} (owner ${benign.owner})`],
      { matchedPolicyId: benign.id, score: 0, priority: 'P4' }
    );
  }

  const reasons = ['No allowlist, threat-intel or known-benign match; analyst review required'];
  if (input.enrichment === undefined || input.enrichment === null) {
    reasons.push('Threat-intel enrichment unavailable; verdict based on detection only');
  }
  return decide('needs_investigation', [...reasons, ...risk.factors]);
}
