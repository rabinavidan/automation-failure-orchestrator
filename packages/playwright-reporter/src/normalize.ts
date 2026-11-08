/**
 * Pure helpers that turn Playwright results into stable, contract-shaped values. Stability
 * matters: testId and the error feed the failure fingerprint, so the same failure must produce
 * the same values on every machine and every run.
 */
import { relative, sep } from 'path';

// ESC [ ... final-byte: the colour codes Playwright puts in expect() messages.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** `tests/api/orders.spec.ts`, relative to the Playwright root and with POSIX separators. */
export function relativeFile(rootDir: string, file: string): string {
  return relative(rootDir, file).split(sep).join('/');
}

function slug(part: string): string {
  return part.trim().replace(/\s+/g, '-').toLowerCase();
}

/**
 * `tests/api/orders.spec.ts::checkout>create-order-returns-201`: file plus the describe path,
 * so identical titles in different describe blocks never collide.
 */
export function stableTestId(file: string, titlePath: string[]): string {
  return `${file}::${titlePath.map(slug).join('>')}`;
}

/**
 * The error class for fingerprinting. Playwright reports every failure as `Error: ...`, so
 * the name is recovered from the message: an explicit `TimeoutError:` prefix, an `expect(...)`
 * assertion, or a test timeout.
 */
export function errorName(message: string, status: string): string {
  if (status === 'timedOut') return 'TimeoutError';
  const named = /^\s*([A-Z][A-Za-z]*Error)\b/.exec(message)?.[1];
  if (named && named !== 'Error') return named;
  if (/\bexpect\(/.test(message)) return 'AssertionError';
  return named ?? 'Error';
}

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export function asSeverity(value: string | undefined): Severity | undefined {
  return SEVERITIES.find((s) => s === value);
}
