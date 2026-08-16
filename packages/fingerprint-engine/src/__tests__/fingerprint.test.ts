import { describe, it, expect } from 'vitest';
import { generateFingerprint, shortFingerprint, fingerprintLabel } from '../fingerprint';
import { normalizeMessage } from '../normalizer';
import type { FingerprintInput } from '@orchestrator/shared-types';

describe('normalizeMessage', () => {
  it('strips UUIDs', () => {
    const msg = 'Error for user 550e8400-e29b-41d4-a716-446655440000';
    expect(normalizeMessage(msg)).toBe('Error for user <UUID>');
  });

  it('strips ISO timestamps', () => {
    const msg = 'Failed at 2024-01-15T10:30:00.000Z';
    expect(normalizeMessage(msg)).toBe('Failed at <TIMESTAMP>');
  });

  it('strips request IDs', () => {
    const msg = 'Request req-abc123def failed';
    expect(normalizeMessage(msg)).toBe('Request <REQ_ID> failed');
  });

  it('strips session IDs', () => {
    const msg = 'Session sess-xyz789abc expired';
    expect(normalizeMessage(msg)).toBe('Session <REQ_ID> expired');
  });

  it('strips hex IDs of 8+ chars', () => {
    const msg = 'Token abcdef12 is invalid';
    expect(normalizeMessage(msg)).toBe('Token <HEX_ID> is invalid');
  });

  it('strips temp paths', () => {
    const msg = 'File /tmp/abc123xyz not found';
    expect(normalizeMessage(msg)).toBe('File /tmp/<TEMP> not found');
  });

  it('replaces port numbers in URLs', () => {
    const msg = 'Connect to http://localhost:8080/api failed';
    expect(normalizeMessage(msg)).toBe('Connect to http://localhost:<PORT>/api failed');
  });

  it('preserves the core error message structure', () => {
    const msg = 'ECONNREFUSED connection to database';
    expect(normalizeMessage(msg)).toBe('ECONNREFUSED connection to database');
  });
});

describe('generateFingerprint', () => {
  const baseInput: FingerprintInput = {
    testId: 'tests/api/checkout.spec.ts::checkout-success',
    service: 'checkout-service',
    errorName: 'Error',
    errorMessage: 'Expected status 200, got 500',
    endpoint: '/api/checkout',
  };

  it('same input always produces same fingerprint', () => {
    const fp1 = generateFingerprint(baseInput);
    const fp2 = generateFingerprint(baseInput);
    expect(fp1).toBe(fp2);
  });

  it('different testId produces different fingerprint', () => {
    const fp1 = generateFingerprint(baseInput);
    const fp2 = generateFingerprint({ ...baseInput, testId: 'other-test' });
    expect(fp1).not.toBe(fp2);
  });

  it('different error name produces different fingerprint', () => {
    const fp1 = generateFingerprint(baseInput);
    const fp2 = generateFingerprint({ ...baseInput, errorName: 'TypeError' });
    expect(fp1).not.toBe(fp2);
  });

  it('different error message produces different fingerprint', () => {
    const fp1 = generateFingerprint(baseInput);
    const fp2 = generateFingerprint({ ...baseInput, errorMessage: 'Expected 404' });
    expect(fp1).not.toBe(fp2);
  });

  it('dynamic UUIDs in error message do NOT change fingerprint', () => {
    const fp1 = generateFingerprint({
      ...baseInput,
      errorMessage: 'User 550e8400-e29b-41d4-a716-446655440000 not found',
    });
    const fp2 = generateFingerprint({
      ...baseInput,
      errorMessage: 'User 11111111-2222-3333-4444-555555555555 not found',
    });
    expect(fp1).toBe(fp2);
  });

  it('dynamic timestamps in error message do NOT change fingerprint', () => {
    const fp1 = generateFingerprint({
      ...baseInput,
      errorMessage: 'Token expired at 2024-01-01T00:00:00.000Z',
    });
    const fp2 = generateFingerprint({
      ...baseInput,
      errorMessage: 'Token expired at 2025-06-15T12:30:00.000Z',
    });
    expect(fp1).toBe(fp2);
  });

  it('dynamic request IDs do NOT change fingerprint', () => {
    const fp1 = generateFingerprint({
      ...baseInput,
      errorMessage: 'Request req-abc123 failed with status 500',
    });
    const fp2 = generateFingerprint({
      ...baseInput,
      errorMessage: 'Request req-xyz789 failed with status 500',
    });
    expect(fp1).toBe(fp2);
  });

  it('missing optional fields produce consistent fingerprint', () => {
    const minimalInput: FingerprintInput = {
      testId: 'test-id',
      errorName: 'Error',
      errorMessage: 'Something went wrong',
    };
    const fp1 = generateFingerprint(minimalInput);
    const fp2 = generateFingerprint(minimalInput);
    expect(fp1).toBe(fp2);
  });

  it('produces a 64-char hex string (SHA-256)', () => {
    const fp = generateFingerprint(baseInput);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('shortFingerprint', () => {
  it('returns first 12 chars', () => {
    const fp = 'abcdef123456789012345678901234567890123456789012345678901234abcd';
    expect(shortFingerprint(fp)).toBe('abcdef123456');
  });
});

describe('fingerprintLabel', () => {
  it('returns prefixed label with short fingerprint', () => {
    const fp = 'abcdef123456789012345678901234567890123456789012345678901234abcd';
    expect(fingerprintLabel(fp)).toBe('automation-fingerprint-abcdef123456');
  });
});
