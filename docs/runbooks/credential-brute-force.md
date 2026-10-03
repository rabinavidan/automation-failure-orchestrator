# Runbook: Credential Brute Force / Password Spraying

Techniques: T1110, T1110.001, T1110.003

## Triage

1. Confirm the source: is the source IP internal, a known scanner, or external? Check the
   threat-intel enrichment (AbuseIPDB confidence, VirusTotal detections, ASN).
2. Count failed vs. successful authentications for the targeted account(s) in the window.
   A success after many failures from the same source is a likely compromise.
3. Determine scope: one account from one source (brute force) or many accounts from one
   source (password spraying).

## Response

- External source with malicious reputation, no successful login: **block the source IP at the
  edge firewall/WAF [approval]**, keep monitoring the account.
- Any successful login after failures: **disable the account and revoke active sessions
  [approval]**, force a password reset with MFA re-enrollment, open an incident.
- Internal source: identify the host owner; treat the host as potentially compromised and
  follow the malware-execution runbook.

## Close criteria

Source blocked or explained, no successful authentication from the source, account owner
confirmed activity, MFA enforced on the targeted account.
