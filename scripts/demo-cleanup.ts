/**
 * Remove demo-owned CI records only: test runs posted by the demo scripts
 * (`triggered_by = 'demo-script'`), plus everything that cascades from them (test results,
 * agent executions and their events/model calls, approval requests).
 *
 * Dry run by default: prints counts and deletes nothing. Pass --confirm to delete.
 * It never truncates tables and never touches runs from other sources. Known gaps: failure_history
 * rows (keyed by fingerprint, shared with real runs), LangGraph checkpoint rows and SOC demo alerts
 * have no reliable demo marker, so they are left alone.
 *
 *   npm run demo:cleanup             # dry run
 *   npm run demo:cleanup -- --confirm
 */
import { Client } from 'pg';

const DEMO_TRIGGER = 'demo-script';

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const counts = await client.query<{ runs: string; results: string; executions: string }>(
      `SELECT
         (SELECT COUNT(*) FROM test_runs WHERE triggered_by = $1) AS runs,
         (SELECT COUNT(*) FROM test_results r JOIN test_runs t ON t.run_id = r.run_id
            WHERE t.triggered_by = $1) AS results,
         (SELECT COUNT(*) FROM agent_executions e JOIN test_runs t ON t.run_id = e.run_id
            WHERE t.triggered_by = $1) AS executions`,
      [DEMO_TRIGGER]
    );
    const { runs, results, executions } = counts.rows[0];
    console.log(
      `Demo-owned records (triggered_by='${DEMO_TRIGGER}'): ${runs} runs, ${results} test results, ${executions} agent executions`
    );
    if (!confirm) {
      console.log('Dry run: nothing deleted. Re-run with --confirm to delete these records.');
      return;
    }
    const deleted = await client.query('DELETE FROM test_runs WHERE triggered_by = $1', [
      DEMO_TRIGGER,
    ]);
    console.log(`Deleted ${deleted.rowCount ?? 0} demo runs (dependent rows removed by cascade).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('demo:cleanup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
