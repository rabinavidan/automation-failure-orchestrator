# Runbook: Phishing

Techniques: T1566, T1566.001, T1566.002

## Triage

1. Analyse sender, reply-to, and authentication results (SPF, DKIM, DMARC).
2. Check URLs and attachment hashes against threat intel.
3. Identify all recipients and whether anyone clicked or submitted credentials.

## Response

- Purge the message from all mailboxes.
- **Block the sender domain and malicious URLs [approval]**.
- For users who submitted credentials: **reset password and revoke sessions [approval]**.

## Close criteria

Message purged, indicators blocked, affected users remediated and notified.
