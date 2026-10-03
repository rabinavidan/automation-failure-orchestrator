import type { SentinelAlert, WazuhAlert } from '@orchestrator/shared-types';

/** Sentinel scheduled analytic rule alert, as delivered by a Logic App. */
export const sentinelBruteForce: SentinelAlert = {
  SystemAlertId: '7d3e1a52-5b1c-4f0e-9d6a-2b9c8e1f0a11',
  AlertDisplayName: 'Brute force attack against Azure AD account',
  AlertType: '0b9ae89d-8cad-461c-808f-0494f70ad5c4_brute_force',
  Severity: 'High',
  Description: 'Multiple failed sign-ins followed by lockout',
  ProductName: 'Azure Sentinel',
  StartTimeUtc: '2026-10-03T12:00:00Z',
  Tactics: 'CredentialAccess, InitialAccess',
  Techniques: '["T1110","T1110.003"]',
  Entities: JSON.stringify([
    { $id: '2', Type: 'account', Name: 'jdoe', UPNSuffix: 'corp.example.com' },
    { $id: '3', Type: 'ip', Address: '203.0.113.21' },
    { $id: '4', Type: 'ip', Address: '10.0.0.5' },
    { $id: '5', Type: 'host', HostName: 'ws-042', DnsDomain: 'corp.example.com' },
  ]),
  AlertUri: 'https://portal.azure.com/#blade/Microsoft_Azure_Security/AlertBlade/alertId/7d3e1a52',
};

/** Sentinel MDE malware alert with file hash, URL and process entities (array form). */
export const sentinelMalware: SentinelAlert = {
  SystemAlertId: 'b2f9b8a0-0000-4000-8000-000000000002',
  AlertDisplayName: 'Malicious file executed',
  Severity: 'Medium',
  TimeGenerated: '2026-10-03T13:00:00Z',
  Tactics: ['Execution', 'CommandAndControl'],
  Entities: [
    {
      Type: 'file',
      Name: 'invoice.exe',
      FileHashes: [{ Algorithm: 'MD5', Value: '44D88612FEA8A8F36DE82E1278ABB02F' }],
    },
    { Type: 'url', Url: 'http://evil.example.net/payload' },
    { Type: 'process', CommandLine: 'C:\\Users\\jdoe\\Downloads\\invoice.exe /silent' },
    { Type: 'dns', DomainName: 'evil.example.net' },
    { Type: 'mailbox', MailboxPrimaryAddress: 'jdoe@corp.example.com' },
    { Type: 'unknown-type', Foo: 'bar' },
  ],
};

/** Wazuh sshd brute-force rule (5712) via a custom integration. */
export const wazuhSshBruteForce: WazuhAlert = {
  id: '1759492800.123456',
  timestamp: '2026-10-03T12:00:00.000+0000',
  rule: {
    id: '5712',
    level: 10,
    description: 'sshd: brute force trying to get access to the system. Non existent user.',
    groups: ['syslog', 'sshd', 'authentication_failures'],
    mitre: { id: ['T1110'], tactic: ['Credential Access'] },
  },
  agent: { id: '003', name: 'web-01', ip: '10.0.1.20' },
  data: { srcip: '203.0.113.22', dstuser: 'root' },
};
