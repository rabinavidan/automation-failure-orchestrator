const INFRASTRUCTURE_PATTERNS = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /\bDNS\b/i,
  /connection refused/i,
  /gateway timeout/i,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /browser.*launch/i,
  /launch.*browser/i,
  /chromium.*not found/i,
  /playwright.*browser/i,
  /ETIMEDOUT/i,
  /timeout.*connect/i,
  /pod.*unavailable/i,
  /service.*unavailable/i,
  /ECONNRESET/i,
];

export function isInfrastructureFailure(errorText: string): boolean {
  return INFRASTRUCTURE_PATTERNS.some((pattern) => pattern.test(errorText));
}
