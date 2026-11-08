/**
 * Compares evaluation quality between two model or prompt/graph versions
 * using recent production data, so a model, prompt, or context change can
 * be judged as an improvement or a regression before it ships wider.
 *
 * Usage:
 *   npm run compare:versions --workspace=apps/ingestion-service -- \
 *     --before-model=qwen3:4b --after-model=llama3:8b [--limit=100]
 *   npm run compare:versions --workspace=apps/ingestion-service -- \
 *     --before-graph=failure-agent-v1 --after-graph=failure-supervisor-v1
 */
import { config } from '@orchestrator/ingestion-service/config';
import { createOllamaClient } from '@orchestrator/ingestion-service/services/model-client';
import { closePool } from '@orchestrator/ingestion-service/db/client';
import { createDatabaseExecutionFetcher } from '../failure-modes/execution-fetcher';
import { sampleProductionFailureModes } from '../failure-modes/failure-mode-taxonomy';
import {
  compareFailureModeReports,
  type VersionComparison,
} from '../failure-modes/version-comparison';
import type { InvestigationModel } from '@orchestrator/ingestion-service/services/failure-investigation-agent';

function parseArg(name: string): string | undefined {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

function parseLimit(): number {
  const parsed = Number.parseInt(parseArg('limit') ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

/** The judge model, from the same factory as the agents; none when AI is disabled. */
function createJudgeClient(): InvestigationModel | undefined {
  return config().AI_ENABLED ? createOllamaClient().client : undefined;
}

function printComparison(comparison: VersionComparison): void {
  const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
  console.log(
    `\n${comparison.before.label}: ${comparison.before.cleanCount}/${comparison.before.sampleSize} clean (${pct(comparison.before.passRate)})`
  );
  console.log(
    `${comparison.after.label}: ${comparison.after.cleanCount}/${comparison.after.sampleSize} clean (${pct(comparison.after.passRate)})`
  );
  console.log(
    `Pass rate delta: ${comparison.passRateDelta >= 0 ? '+' : ''}${pct(comparison.passRateDelta)}`
  );
  console.log(`Verdict: ${comparison.verdict.toUpperCase()}\n`);
  console.log('Failure mode deltas (after - before):');
  for (const [mode, delta] of Object.entries(comparison.modeDeltas)) {
    if (delta === 0) continue;
    console.log(`  ${mode}: ${delta > 0 ? '+' : ''}${delta}`);
  }
}

async function main() {
  const limit = parseLimit();
  const beforeModel = parseArg('before-model');
  const afterModel = parseArg('after-model');
  const beforeGraph = parseArg('before-graph');
  const afterGraph = parseArg('after-graph');

  if (!(beforeModel && afterModel) && !(beforeGraph && afterGraph)) {
    console.error(
      'Provide either --before-model/--after-model or --before-graph/--after-graph to select the two versions to compare.'
    );
    process.exitCode = 1;
    return;
  }

  const judgeClient = createJudgeClient();
  const evalOptions = {
    limit,
    ragExpected: config().RAG_ENABLED,
    multiAgentExpected: config().MULTI_AGENT_ENABLED,
    judgeClient,
    judgeModel: config().OLLAMA_MODEL,
  };

  const beforeFilter = { model: beforeModel, graphVersion: beforeGraph };
  const afterFilter = { model: afterModel, graphVersion: afterGraph };
  const beforeLabel = beforeModel ?? beforeGraph!;
  const afterLabel = afterModel ?? afterGraph!;

  console.log(
    `Comparing "${beforeLabel}" (before) against "${afterLabel}" (after), up to ${limit} samples each`
  );
  const [beforeReport, afterReport] = await Promise.all([
    sampleProductionFailureModes(createDatabaseExecutionFetcher(beforeFilter), evalOptions),
    sampleProductionFailureModes(createDatabaseExecutionFetcher(afterFilter), evalOptions),
  ]);

  printComparison(
    compareFailureModeReports(beforeReport, afterReport, { beforeLabel, afterLabel })
  );
  await closePool();
}

main().catch((error) => {
  console.error('[compare-versions] failed:', error);
  process.exitCode = 1;
});
