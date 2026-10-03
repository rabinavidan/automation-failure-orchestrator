# Runbook: Credential Dumping (LSASS access, Mimikatz)

Techniques: T1003, T1003.001

## Triage

1. Identify the process that accessed LSASS memory and its parent chain; check signer and path.
2. Check whether the host is a domain controller, jump host, or server with privileged sessions.
3. Look for lateral movement from the host after the detection (remote services, SMB, RDP).

## Response

- Treat as confirmed compromise when the accessing process is unsigned or a known tool.
- **Isolate the host from the network via EDR [approval]**.
- **Reset credentials of every account with a session on the host [approval]**, starting with
  privileged accounts; consider a KRBTGT double reset if a domain controller is involved.
- Preserve memory and disk evidence before remediation.

## Close criteria

Host reimaged or verified clean, all exposed credentials rotated, no further lateral movement.
