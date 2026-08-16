const AUTOMATION_PATTERNS = [
  /locator.*strict mode/i,
  /strict mode violation/i,
  /waiting for.*selector/i,
  /no element found/i,
  /element not found/i,
  /fixture.*not found/i,
  /unknown fixture/i,
  /Cannot find module/i,
  /SyntaxError/i,
  /TypeError.*import/i,
  /test.*setup.*failed/i,
  /beforeAll.*failed/i,
  /reporter.*error/i,
];

export function isAutomationFailure(errorText: string): boolean {
  return AUTOMATION_PATTERNS.some((pattern) => pattern.test(errorText));
}
