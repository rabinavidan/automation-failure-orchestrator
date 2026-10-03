# SOC Runbooks

Incident-response runbooks used by the SOC response-planner agent (M4) and, from M5, by the
response playbook engine. Each runbook declares the MITRE ATT&CK techniques it covers on a
`Techniques:` line; the agent selects runbooks deterministically by technique and cites them
by file name. Runbooks are also indexed by the repository RAG (`docs/` is indexed).

Containment steps marked **[approval]** are never executed automatically: they require a
human decision in the dashboard (see the safety model in the README).

| Runbook                                                | Techniques                 |
| ------------------------------------------------------ | -------------------------- |
| [credential-brute-force.md](credential-brute-force.md) | T1110                      |
| [credential-dumping.md](credential-dumping.md)         | T1003                      |
| [malware-execution.md](malware-execution.md)           | T1204, T1059, T1105, T1071 |
| [phishing.md](phishing.md)                             | T1566                      |
| [ransomware.md](ransomware.md)                         | T1486, T1490               |
| [suspicious-sign-in.md](suspicious-sign-in.md)         | T1078                      |
| [generic-alert-triage.md](generic-alert-triage.md)     | fallback                   |
