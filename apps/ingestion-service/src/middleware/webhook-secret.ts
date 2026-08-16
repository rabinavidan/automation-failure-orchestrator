import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export function webhookSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.WEBHOOK_SECRET;

  // If no secret configured, allow all requests (dev mode)
  if (!secret) {
    next();
    return;
  }

  const provided = req.get('x-webhook-secret');

  if (!provided) {
    res.status(401).json({ error: 'Missing x-webhook-secret header' });
    return;
  }

  try {
    const secretBuf = Buffer.from(secret, 'utf-8');
    const providedBuf = Buffer.from(provided, 'utf-8');

    // Buffers must be same length for timingSafeEqual
    if (secretBuf.length !== providedBuf.length) {
      res.status(403).json({ error: 'Invalid webhook secret' });
      return;
    }

    if (!timingSafeEqual(secretBuf, providedBuf)) {
      res.status(403).json({ error: 'Invalid webhook secret' });
      return;
    }

    next();
  } catch {
    res.status(403).json({ error: 'Invalid webhook secret' });
  }
}
