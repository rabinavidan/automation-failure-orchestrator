import { Router } from 'express';
import { z } from 'zod';
import {
  getRepositoryKnowledgeStatus,
  reindexRepositoryKnowledge,
  searchRepositoryKnowledge,
} from '../services/repository-knowledge';

const router = Router();

router.get('/status', async (_req, res) => {
  try {
    res.json(await getRepositoryKnowledgeStatus());
  } catch (error) {
    console.error('[Knowledge] Status error:', error);
    res.status(500).json({ error: 'Failed to load knowledge index status' });
  }
});

const SearchSchema = z.object({
  query: z.string().trim().min(3).max(1000),
  topK: z.number().int().min(1).max(8).optional(),
});

router.post('/search', async (req, res) => {
  const parsed = SearchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid search request', details: parsed.error.flatten() });
    return;
  }
  try {
    const matches = await searchRepositoryKnowledge(parsed.data.query, parsed.data.topK);
    res.json({ matches });
  } catch (error) {
    console.error('[Knowledge] Search error:', error);
    res.status(503).json({ error: 'Repository search unavailable' });
  }
});

router.post('/reindex', async (_req, res) => {
  try {
    const result = await reindexRepositoryKnowledge();
    res.status(201).json(result);
  } catch (error) {
    console.error('[Knowledge] Reindex error:', error);
    res.status(503).json({ error: 'Repository reindex failed' });
  }
});

export default router;
