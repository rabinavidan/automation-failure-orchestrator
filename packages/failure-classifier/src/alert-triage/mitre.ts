import type { SecurityAlert } from '@orchestrator/shared-types';

/** Parent technique -> ATT&CK tactic (enterprise matrix, subset relevant to SOC alerting). */
export const TECHNIQUE_TACTICS: Record<string, string> = {
  T1003: 'Credential Access',
  T1021: 'Lateral Movement',
  T1041: 'Exfiltration',
  T1048: 'Exfiltration',
  T1059: 'Execution',
  T1071: 'Command and Control',
  T1078: 'Initial Access',
  T1105: 'Command and Control',
  T1110: 'Credential Access',
  T1190: 'Initial Access',
  T1204: 'Execution',
  T1486: 'Impact',
  T1490: 'Impact',
  T1566: 'Initial Access',
  T1569: 'Execution',
};

/** Techniques that are near-certain compromise indicators when detected at high severity. */
export const HIGH_CONFIDENCE_TECHNIQUES = new Set(['T1003', 'T1486', 'T1490']);

/** Tactics late in the kill chain: the attacker is already inside. */
export const HIGH_IMPACT_TACTICS = new Set([
  'Credential Access',
  'Lateral Movement',
  'Exfiltration',
  'Impact',
  'Command and Control',
]);

/**
 * Fallback mapping when the SIEM rule carries no ATT&CK annotation. Ordered:
 * the first matching pattern wins, so specific patterns come first.
 */
const RULE_NAME_INFERENCE: Array<[RegExp, string]> = [
  [/ransom|encrypt(ed|ion) for impact/i, 'T1486'],
  [/shadow cop(y|ies)|vssadmin|inhibit.*recovery/i, 'T1490'],
  [/mimikatz|lsass|credential dump|hashdump/i, 'T1003'],
  [/brute.?force|password spray|excessive (failed )?log(in|on)s?/i, 'T1110'],
  [/phish/i, 'T1566'],
  [/impossible travel|anomalous (login|sign-?in)|valid account/i, 'T1078'],
  [/powershell|cmd\.exe|command.?line|script(ing)? interpreter/i, 'T1059'],
  [/psexec|lateral movement|remote service|rdp|smb admin/i, 'T1021'],
  [/exfiltrat|data transfer/i, 'T1041'],
  [/beacon|c2|command.and.control/i, 'T1071'],
  [/malware|trojan|malicious file|user execution/i, 'T1204'],
  [/exploit.*public|web shell|webshell/i, 'T1190'],
];

export function parentTechnique(id: string): string {
  return id.split('.')[0] ?? id;
}

export function resolveMitre(alert: SecurityAlert): {
  tactics: string[];
  techniques: string[];
  inferred: boolean;
} {
  let techniques = alert.mitre?.techniques ?? [];
  let inferred = false;

  if (techniques.length === 0) {
    const haystack = `${alert.ruleName} ${alert.title}`;
    const hit = RULE_NAME_INFERENCE.find(([pattern]) => pattern.test(haystack));
    if (hit) {
      techniques = [hit[1]];
      inferred = true;
    }
  }

  const tactics = new Set(alert.mitre?.tactics ?? []);
  for (const technique of techniques) {
    const tactic = TECHNIQUE_TACTICS[parentTechnique(technique)];
    if (tactic) tactics.add(tactic);
  }

  return { tactics: [...tactics], techniques: [...techniques], inferred };
}
