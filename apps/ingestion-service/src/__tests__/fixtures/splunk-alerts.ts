import type { SplunkAlertWebhook } from '@orchestrator/shared-types';

/** Splunk ES "Brute Force Access Behavior Detected" webhook alert action payload. */
export const splunkBruteForceAlert: SplunkAlertWebhook = {
  sid: 'scheduler__admin__SplunkEnterpriseSecuritySuite__RMD5a1b2c3d4_at_1759500000_123',
  search_name: 'Access - Brute Force Access Behavior Detected - Rule',
  app: 'SplunkEnterpriseSecuritySuite',
  owner: 'admin',
  results_link: 'https://splunk.example.com/app/search/@go?sid=scheduler__admin_123',
  result: {
    _time: '1759500000.000',
    signature: 'Brute Force Access Behavior Detected',
    src: '203.0.113.7',
    dest: 'WS-042.corp.example.com',
    user: 'CORP\\jdoe',
    count: '57',
    urgency: 'high',
    mitre_tactic: 'Credential Access',
    'annotations.mitre_attack': ['T1110', 'T1110.001'],
  },
};

/** Splunk ES malware detection with a file hash and process. */
export const splunkMalwareAlert: SplunkAlertWebhook = {
  sid: 'scheduler__admin__SplunkEnterpriseSecuritySuite__RMD5e5f6_at_1759500300_456',
  search_name: 'Endpoint - Malware Detected - Rule',
  app: 'SplunkEnterpriseSecuritySuite',
  result: {
    _time: '2025-10-03T14:05:00Z',
    signature: 'Trojan.GenericKD detected',
    dest: '10.20.30.40',
    dest_host: 'srv-db-01',
    user: 'svc_backup@corp.example.com',
    file_hash: '44d88612fea8a8f36de82e1278abb02f',
    process_name: 'invoice.exe',
    url: 'http://malicious.example.net/payload',
    severity: '5',
    mitre_technique_id: 'T1204.002',
  },
};
