/**
 * Normalizes error messages by stripping dynamic/runtime-specific values
 * so that the same logical error always produces the same fingerprint.
 */

// UUID pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ISO 8601 timestamps
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;

// Request/session IDs like req-abc123, sess-xyz789
const REQ_SESS_PATTERN = /\b(?:req|sess|request|session)-[a-z0-9]+\b/gi;

// Standalone hex IDs of 8+ chars
const HEX_ID_PATTERN = /\b[0-9a-f]{8,}\b/g;

// Temp paths like /tmp/abc123xyz
const TEMP_PATH_PATTERN = /\/tmp\/[^\s/]+/g;

// Port numbers in URLs: :8080/ → :<PORT>/
const PORT_PATTERN = /:(\d+)\//g;

// Numeric IDs in error messages (e.g., "item 12345 not found")
const NUMERIC_ID_PATTERN = /\b\d{4,}\b/g;

export function normalizeMessage(message: string): string {
  return message
    .replace(UUID_PATTERN, '<UUID>')
    .replace(TIMESTAMP_PATTERN, '<TIMESTAMP>')
    .replace(REQ_SESS_PATTERN, '<REQ_ID>')
    .replace(HEX_ID_PATTERN, '<HEX_ID>')
    .replace(TEMP_PATH_PATTERN, '/tmp/<TEMP>')
    .replace(PORT_PATTERN, ':<PORT>/')
    .replace(NUMERIC_ID_PATTERN, '<NUM>')
    .trim();
}
