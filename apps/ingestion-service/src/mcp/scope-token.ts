import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';

/**
 * An evidence scope binds one MCP session to one investigation. It is minted server-side when an
 * investigation starts and held by the MCP client; the model never sees it, so nothing the model
 * writes (or text injected into retrieved evidence) can widen what the tools may read.
 */
export const EvidenceScopeSchema = z.object({
  threadId: z.string().min(1).max(300),
  runId: z.string().min(1).max(255),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  testId: z.string().min(1).max(500),
  exp: z.number().int().positive(),
});

export type EvidenceScope = z.infer<typeof EvidenceScopeSchema>;

const MIN_SECRET_LENGTH = 16;

export function mcpScopeSecret(env: Record<string, string | undefined> = process.env) {
  const secret = env.MCP_SCOPE_SECRET;
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : undefined;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function mintScopeToken(
  scope: Omit<EvidenceScope, 'exp'>,
  secret: string,
  ttlSeconds = 900,
  now = Date.now()
): string {
  const body: EvidenceScope = { ...scope, exp: Math.floor(now / 1000) + ttlSeconds };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the scope for a valid, unexpired token signed with `secret`; otherwise null. */
export function verifyScopeToken(
  token: string | undefined,
  secret: string,
  now = Date.now()
): EvidenceScope | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = EvidenceScopeSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
    );
    if (!parsed.success || parsed.data.exp * 1000 <= now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
