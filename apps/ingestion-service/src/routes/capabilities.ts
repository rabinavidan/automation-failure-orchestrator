import { Router } from 'express';
import { getRuntimeCapabilities } from '../services/runtime-capabilities';

const router = Router();

/** Configured mode and current availability per dimension (model, integrations, queue, enrichment). */
router.get('/', async (_req, res) => {
  res.json(await getRuntimeCapabilities());
});

export default router;
