import { z } from 'zod';

/**
 * The service's configuration: every environment variable it reads, parsed and validated in
 * one place. `config()` parses the current environment on each call (about 30 fields, so the
 * cost is negligible), which keeps offline tools that adjust `process.env` at runtime working.
 * Entry points call `validateConfig()` at startup so an invalid value stops the process with a
 * message naming the variable, instead of silently falling back: before, `AI_ENABLED=ture`
 * quietly meant "agents off".
 *
 * Path settings stay optional here; the module that owns the path supplies its default.
 */

type Env = Record<string, string | undefined>;

// Unset and empty both mean "use the default".
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const flag = (fallback: boolean) =>
  z
    .preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).optional())
    .transform((v) => (v === undefined ? fallback : v === 'true'));

const integer = (fallback: number, min: number) =>
  z
    .preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(min).optional())
    .transform((v) => v ?? fallback);

const text = (fallback: string) => optional(z.string()).transform((v) => v ?? fallback);
const url = optional(z.string().url());
const urlOr = (fallback: string) => url.transform((v) => v ?? fallback);
const choice = <T extends [string, ...string[]]>(values: T, fallback: T[number]) =>
  optional(z.enum(values)).transform((v) => v ?? fallback);

const ConfigSchema = z
  .object({
    PORT: integer(3001, 1),
    SHUTDOWN_GRACE_MS: integer(10_000, 0),
    DATABASE_URL: optional(z.string()),
    PGHOST: optional(z.string()),
    WEBHOOK_SECRET: optional(z.string()),
    REVIEWER_TOKENS: optional(z.string()),

    JIRA_BASE_URL: urlOr('http://localhost:3002'),
    JIRA_PROJECT_KEY: text('AUTO'),
    SLACK_WEBHOOK_URL: url,

    AI_ENABLED: flag(false),
    MULTI_AGENT_ENABLED: flag(false),
    RAG_ENABLED: flag(false),
    OLLAMA_HOST: urlOr('http://localhost:11434'),
    OLLAMA_MODEL: text('qwen3:4b'),
    OLLAMA_EMBEDDING_MODEL: text('nomic-embed-text'),
    OLLAMA_TIMEOUT_MS: integer(30_000, 1),
    EVIDENCE_TRANSPORT: choice(['direct', 'mcp'], 'direct'),
    MCP_EVIDENCE_URL: url,
    RAG_SOURCE_ROOT: optional(z.string()),

    INVESTIGATION_QUEUE: choice(['in_process', 'sqs'], 'in_process'),
    INVESTIGATION_QUEUE_URL: url,

    ENRICHMENT_URL: url,
    ENRICHMENT_TIMEOUT_MS: integer(8000, 1),
    ALERT_SUPPRESSION_WINDOW_MINUTES: integer(60, 0),
    RECOVERY_PASS_THRESHOLD: integer(3, 1),
    SOC_ACTIONS_BASE_URL: urlOr('http://localhost:3002'),
    SOC_PROTECTED_HOSTS: text('').transform((v) =>
      v
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean)
    ),
    SOC_TRIAGE_POLICY_PATH: optional(z.string()),
    SOC_PLAYBOOK_DIR: optional(z.string()),
    SOC_RUNBOOK_DIR: optional(z.string()),
    BENCHMARK_RESULTS_DIR: optional(z.string()),
  })
  .superRefine((c, ctx) => {
    if (c.INVESTIGATION_QUEUE === 'sqs' && !c.INVESTIGATION_QUEUE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['INVESTIGATION_QUEUE_URL'],
        message: 'is required when INVESTIGATION_QUEUE=sqs',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

// Values are echoed in errors only for these: URLs and strings can carry credentials.
const ECHO_VALUE = new Set([
  'PORT',
  'SHUTDOWN_GRACE_MS',
  'AI_ENABLED',
  'MULTI_AGENT_ENABLED',
  'RAG_ENABLED',
  'OLLAMA_TIMEOUT_MS',
  'EVIDENCE_TRANSPORT',
  'INVESTIGATION_QUEUE',
  'ENRICHMENT_TIMEOUT_MS',
  'ALERT_SUPPRESSION_WINDOW_MINUTES',
  'RECOVERY_PASS_THRESHOLD',
]);

function parse(env: Env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const name = String(issue.path[0] ?? '');
        const value = ECHO_VALUE.has(name) ? ` (got ${JSON.stringify(env[name])})` : '';
        return `${name}: ${issue.message}${value}`;
      })
    );
  }
  return result.data;
}

/** The current configuration. Throws `ConfigError` if a variable is invalid. */
export function config(env: Env = process.env): Config {
  return parse(env);
}

/** Startup check: print every invalid variable and exit, before serving anything. */
export function validateConfig(env: Env = process.env): Config {
  try {
    return parse(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[Config] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
