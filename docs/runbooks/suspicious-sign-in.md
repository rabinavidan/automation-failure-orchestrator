# Runbook: Suspicious Sign-in / Valid Account Abuse

Techniques: T1078, T1078.004

## Triage

1. Compare sign-in location, device, and ASN with the user's baseline (impossible travel).
2. Check the source IP reputation and whether it is an anonymiser (VPN, Tor, hosting ASN).
3. Review activity after sign-in: mailbox rules, MFA changes, data access.

## Response

- Unexplained sign-in from a malicious or anonymising source: **revoke sessions and force
  re-authentication [approval]**, reset the password, and review MFA methods.
- Confirm with the user out of band before closing.

## Close criteria

User confirmed or account remediated, no persistence (mail rules, new MFA devices) remains.
