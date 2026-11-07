/**
 * Samples recently completed agent investigations from the database, scores
 * each with the deterministic evaluator and (when AI_ENABLED=true) the
 * LLM-as-judge grader, and prints a failure-mode breakdown.
 *
 * Usage: npm run sample:failure-modes --workspace=apps/ingestion-service [-- --limit=100]
 */
import { config } from '@orchestrator/ingestion-service/config';
import { createOllamaClient } from '@orchestrator/ingestion-service/services/model-client';
import { closePool } from '@orchestrator/ingestion-service/db/client';
import { createDatabaseExecutionFetcher } from '../failure-modes/execution-fetcher';
import {
  sampleProductionFailureModes,
  type FailureModeReport,
} from '../failure-modes/failure-mode-taxonomy';
import type { InvestigationModel } from '@orchestrator/ingestion-service/services/failure-investigation-agent';

function parseLimit(): number {
  const arg = process.argv.find((value) => value.startsWith('--limit='));
  const parsed = arg ? Number.parseInt(arg.split('=')[1], 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

/** The judge model, from the same factory as the agents; none when AI is disabled. */
function createJudgeClient(): InvestigationModel | undefined {
  return config().AI_ENABLED ? createOllamaClient().client : undefined;
}

function printReport(report: FailureModeReport): void {
  console.log(`\nSampled ${report.sampleSize} completed investigations`);
  console.log(`Clean (no failure mode detected): ${report.cleanCount}\n`);
  console.log('Failure mode breakdown:');
  for (const [mode, count] of Object.entries(report.modeCounts)) {
    if (count === 0) continue;
    console.log(`  ${mode}: ${count}`);
    for (const threadId of report.examples[mode as keyof typeof report.examples]) {
      console.log(`    - ${threadId}`);
    }
  }
}

async function main() {
  const limit = parseLimit();
  const judgeClient = createJudgeClient();
  console.log(
    `Sampling up to ${limit} recent investigations` +
      (judgeClient ? ' (with LLM-as-judge scoring)' : ' (deterministic evaluators only)')
  );
  const report = await sampleProductionFailureModes(createDatabaseExecutionFetcher(), {
    limit,
    ragExpected: config().RAG_ENABLED,
    multiAgentExpected: config().MULTI_AGENT_ENABLED,
    judgeClient,
    judgeModel: config().OLLAMA_MODEL,
  });
  printReport(report);
  await closePool();
}

main().catch((error) => {
  console.error('[sample-failure-modes] failed:', error);
  process.exitCode = 1;
});
