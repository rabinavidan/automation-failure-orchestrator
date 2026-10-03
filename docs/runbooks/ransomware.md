# Runbook: Ransomware / Inhibit System Recovery

Techniques: T1486, T1490

## Triage

1. Confirm encryption activity (mass file renames, ransom notes) or shadow-copy deletion
   (`vssadmin delete shadows`, `wbadmin delete catalog`).
2. Identify patient zero and the user context; check for lateral movement.

## Response

- Treat as a critical incident: page the incident commander immediately.
- **Isolate affected hosts via EDR [approval]**; isolation should not wait on full analysis.
- **Disable the compromised account(s) [approval]**.
- Protect backups: verify offline/immutable backups are intact and disconnect backup networks.

## Close criteria

Spread contained, affected hosts restored from known-good backups, root cause identified.
