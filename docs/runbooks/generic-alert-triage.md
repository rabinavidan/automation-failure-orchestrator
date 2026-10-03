# Runbook: Generic Alert Triage

Techniques: fallback

## Triage

1. Read the detection logic: what behaviour does the rule detect and how noisy is it?
2. Review the entities (host, user, IPs, hashes, URLs) and their threat-intel verdicts.
3. Look for related alerts on the same host or user in the last 24 hours.

## Response

- Insufficient evidence: keep the alert in the analyst queue and gather more telemetry.
- Evidence of compromise: escalate to an incident and follow the runbook for the matching
  ATT&CK technique. Containment always requires **[approval]**.
- Expected activity: document it and propose a known-benign policy entry with an owner and
  an expiry date (config/soc-triage-policy.json).

## Close criteria

A documented disposition with evidence, and any policy change reviewed by its owner.
