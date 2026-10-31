import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Router } from 'express';

const router = Router();

function resultsDir(): string {
  return resolve(
    process.env.BENCHMARK_RESULTS_DIR ?? join(__dirname, '../../../../benchmark/results')
  );
}

/**
 * Benchmark summaries straight from committed report files (summary.json), newest first.
 * Nothing here is hardcoded: if no report exists the list is empty.
 */
router.get('/summary', (_req, res) => {
  const dir = resultsDir();
  if (!existsSync(dir)) {
    res.json({ reports: [] });
    return;
  }
  const reports = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'summary.json')))
    .flatMap((entry) => {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry.name, 'summary.json'), 'utf-8')) as {
          meta: Record<string, unknown>;
          summaries: Array<Record<string, unknown>>;
        };
        return [
          {
            id: entry.name,
            reportPath: `benchmark/results/${entry.name}/report.md`,
            meta: parsed.meta,
            summaries: parsed.summaries.map(({ config, decision, agent, cost }) => ({
              config,
              decision: { byTrack: (decision as { byTrack: unknown }).byTrack },
              agent,
              cost,
            })),
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => String(b.meta.generatedAt).localeCompare(String(a.meta.generatedAt)));
  res.json({ reports });
});

export default router;
