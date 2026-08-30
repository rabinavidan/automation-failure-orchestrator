/**
 * Samples recently completed agent investigations from the database, scores
 * each with the deterministic evaluator and (when AI_ENABLED=true) the
 * LLM-as-judge grader, and prints a failure-mode breakdown.
 *
 * Usage: npm run sample:failure-modes --workspace=apps/ingestion-service [-- --limit=100]
 */
import { Ollama } from 'ollama';
import { closePool } from '../db/client';
import { createDatabaseExecutionFetcher } from '../services/execution-fetcher';
import {
  sampleProductionFailureModes,
  type FailureModeReport,
} from '../services/failure-mode-taxonomy';
import type { InvestigationModel } from '../services/failure-investigation-agent';

function parseLimit(): number {
  const arg = process.argv.find((value) => value.startsWith('--limit='));
  const parsed = arg ? Number.parseInt(arg.split('=')[1], 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

function createJudgeClient(): InvestigationModel | undefined {
  if (process.env.AI_ENABLED !== 'true') return undefined;
  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const timeoutMs = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS ?? '30000', 10);
  return new Ollama({
    host,
    fetch: (input, init) => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
      return fetch(input, { ...init, signal });
    },
  });
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
    ragExpected: process.env.RAG_ENABLED === 'true',
    multiAgentExpected: process.env.MULTI_AGENT_ENABLED === 'true',
    judgeClient,
    judgeModel: process.env.OLLAMA_MODEL ?? 'qwen3:4b',
  });
  printReport(report);
  await closePool();
}

main().catch((error) => {
  console.error('[sample-failure-modes] failed:', error);
  process.exitCode = 1;
});
