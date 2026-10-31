import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Minimal, server-enforced reviewer identity for approval and response endpoints (portfolio
 * scope, not SSO). Identities come from REVIEWER_TOKENS:
 *
 *   REVIEWER_TOKENS="alice:soc_responder+ci_reviewer:<token>;bob:ci_reviewer:<token>"
 *
 * Names and roles may not contain ':', ';' or '+'; tokens may not contain ':' or ';' and must be
 * at least 16 characters. With no identities configured the protected endpoints fail closed (503).
 * The audited reviewer is always the authenticated name, never a value from the request body.
 */
export type ReviewerRole = 'ci_reviewer' | 'soc_responder' | 'admin';
const ROLES = new Set<ReviewerRole>(['ci_reviewer', 'soc_responder', 'admin']);
const MIN_TOKEN_LENGTH = 16;

export interface Reviewer {
  name: string;
  roles: ReviewerRole[];
}

interface Identity extends Reviewer {
  digest: Buffer;
}

const digest = (token: string) => createHash('sha256').update(token).digest();

export function parseReviewerTokens(raw: string | undefined): {
  identities: Identity[];
  errors: string[];
} {
  const identities: Identity[] = [];
  const errors: string[] = [];
  for (const [index, entry] of (raw ?? '').split(';').entries()) {
    if (!entry.trim()) continue;
    const parts = entry.trim().split(':');
    if (parts.length !== 3) {
      errors.push(`entry ${index + 1}: expected name:roles:token`);
      continue;
    }
    const [name, roleList, token] = parts;
    const roles = roleList.split('+').filter(Boolean) as ReviewerRole[];
    if (!/^[\w.@-]{1,120}$/.test(name)) errors.push(`entry ${index + 1}: invalid name`);
    else if (roles.length === 0 || roles.some((r) => !ROLES.has(r)))
      errors.push(`entry ${index + 1}: roles must be ${[...ROLES].join(', ')}`);
    else if (token.length < MIN_TOKEN_LENGTH)
      errors.push(`entry ${index + 1}: token shorter than ${MIN_TOKEN_LENGTH} characters`);
    else identities.push({ name, roles, digest: digest(token) });
  }
  return { identities, errors };
}

let cache: { raw: string | undefined; identities: Identity[] } | null = null;

function identities(): Identity[] {
  const raw = process.env.REVIEWER_TOKENS;
  if (!cache || cache.raw !== raw) {
    const parsed = parseReviewerTokens(raw);
    for (const error of parsed.errors) console.error(`[Auth] REVIEWER_TOKENS ${error}; ignored`);
    cache = { raw, identities: parsed.identities };
  }
  return cache.identities;
}

/** Constant-time lookup over all identities, so timing does not reveal which entry matched. */
export function authenticate(token: string | undefined): Reviewer | null {
  if (!token) return null;
  const given = digest(token);
  let match: Identity | null = null;
  for (const identity of identities()) {
    if (timingSafeEqual(identity.digest, given)) match = identity;
  }
  return match ? { name: match.name, roles: match.roles } : null;
}

function bearer(req: Request): string | undefined {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

/** Require an authenticated reviewer holding `role` (or admin). Sets res.locals.reviewer. */
export function requireRole(role: ReviewerRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (identities().length === 0) {
      res.status(503).json({
        error:
          'Reviewer authentication is not configured (REVIEWER_TOKENS); approvals are disabled',
      });
      return;
    }
    const reviewer = authenticate(bearer(req));
    if (!reviewer) {
      res
        .status(401)
        .set('WWW-Authenticate', 'Bearer')
        .json({ error: 'Reviewer authentication required' });
      return;
    }
    if (!reviewer.roles.includes(role) && !reviewer.roles.includes('admin')) {
      res.status(403).json({ error: `Role ${role} required`, reviewer: reviewer.name });
      return;
    }
    res.locals.reviewer = reviewer;
    next();
  };
}

/** GET handler: who the presented token belongs to (used by the dashboard sign-in). */
export function whoami(req: Request, res: Response): void {
  const reviewer = authenticate(bearer(req));
  if (!reviewer) {
    res.status(401).json({ error: 'Reviewer authentication required' });
    return;
  }
  res.json(reviewer);
}
