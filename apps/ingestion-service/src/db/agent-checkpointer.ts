import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { getPool } from './client';

let checkpointer: PostgresSaver | undefined;
let setupPromise: Promise<void> | undefined;

export async function getAgentCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointer) {
    checkpointer = new PostgresSaver(getPool(), undefined, { schema: 'langgraph' });
  }
  setupPromise ??= checkpointer.setup();
  await setupPromise;
  return checkpointer;
}

export async function setupAgentCheckpointer(): Promise<void> {
  await getAgentCheckpointer();
  console.log('[LangGraph] PostgreSQL checkpointing ready');
}
