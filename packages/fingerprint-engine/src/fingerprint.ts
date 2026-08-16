import { createHash } from 'crypto';
import { normalizeMessage } from './normalizer';
import type { FingerprintInput } from '@orchestrator/shared-types';

export function generateFingerprint(input: FingerprintInput): string {
  const normalized = [
    input.testId,
    input.service ?? '',
    input.errorName,
    normalizeMessage(input.errorMessage),
    input.endpoint ?? '',
  ]
    .join('|')
    .toLowerCase();

  return createHash('sha256').update(normalized).digest('hex');
}

export function shortFingerprint(fp: string): string {
  return fp.slice(0, 12);
}

export function fingerprintLabel(fp: string): string {
  return `automation-fingerprint-${shortFingerprint(fp)}`;
}
