import type { KnowledgeStatus } from '@orchestrator/shared-types';
import { useEffect, useState } from 'react';
import { BookOpen, BrainCircuit, Database } from 'lucide-react';
import { getJson, useViewData } from '../../app/data';
import { useRefresh } from '../../app/refresh-context';
import type { ReviewerSession } from '../../app/useReviewerSession';
import { emptyKnowledge, type KnowledgeMatch } from '../../types';
import { LoadingState, Metric } from '../../ui/primitives';

const loadKnowledgeStatus = (signal: AbortSignal) =>
  getJson<KnowledgeStatus>('/api/ingestion/api/knowledge/status', signal);

/** Repository index status, semantic search and (admin) reindex. */
export function Knowledge({ session }: { session: ReviewerSession }) {
  const { data, settled, reload } = useViewData(loadKnowledgeStatus);
  const { reportError, setCount } = useRefresh();
  const [knowledgeQuery, setKnowledgeQuery] = useState('How are webhook payloads validated?');
  const [knowledgeMatches, setKnowledgeMatches] = useState<KnowledgeMatch[]>([]);
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  useEffect(() => {
    if (data) setCount('knowledge', data.chunkCount);
  }, [data, setCount]);

  const searchKnowledge = async () => {
    if (knowledgeQuery.trim().length < 3) return;
    setKnowledgeBusy(true);
    try {
      const response = await fetch('/api/ingestion/api/knowledge/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: knowledgeQuery, topK: 5 }),
      });
      if (!response.ok) throw new Error('Knowledge search failed');
      const payload = (await response.json()) as { matches?: KnowledgeMatch[] };
      setKnowledgeMatches(payload.matches ?? []);
    } catch (searchError) {
      reportError(searchError, 'Knowledge search failed');
    } finally {
      setKnowledgeBusy(false);
    }
  };

  const reindexKnowledge = async () => {
    setKnowledgeBusy(true);
    try {
      const response = await fetch('/api/ingestion/api/knowledge/reindex', {
        method: 'POST',
        headers: session.authHeader,
      });
      if (!response.ok) throw new Error('Knowledge reindex failed');
      await reload();
    } catch (reindexError) {
      reportError(reindexError, 'Knowledge reindex failed');
    } finally {
      setKnowledgeBusy(false);
    }
  };

  if (!settled) return <LoadingState />;
  const knowledge = data ?? emptyKnowledge;

  return (
    <section className="page-enter space-y-6 py-7">
      <div className="grid gap-4 sm:grid-cols-3">
        <Metric
          label="Indexed chunks"
          value={knowledge.chunkCount}
          note="LlamaIndex sentence chunks"
          icon={Database}
          accent="bg-signal"
        />
        <Metric
          label="Sources"
          value={knowledge.sourceCount}
          note="Allowlisted repository files"
          icon={BookOpen}
          accent="bg-cyan"
        />
        <Metric
          label="Embedding"
          value={knowledge.latestRun?.status ?? 'not indexed'}
          note={knowledge.latestRun?.embedding_model ?? 'nomic-embed-text'}
          icon={BrainCircuit}
          accent="bg-violet-500"
        />
      </div>
      <div className="border border-ink/10 bg-white p-5 shadow-panel">
        <div className="flex flex-col gap-4 lg:flex-row">
          <input
            value={knowledgeQuery}
            onChange={(event) => setKnowledgeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void searchKnowledge();
            }}
            className="min-w-0 flex-1 border border-slate-300 px-4 py-3 text-sm outline-none focus:border-ink"
            placeholder="Search repository knowledge"
          />
          <button
            onClick={() => void searchKnowledge()}
            disabled={knowledgeBusy}
            className="bg-ink px-5 py-3 text-xs font-bold text-signal disabled:opacity-50"
          >
            Semantic search
          </button>
          <button
            onClick={() => void reindexKnowledge()}
            disabled={knowledgeBusy}
            className="border border-ink px-5 py-3 text-xs font-bold disabled:opacity-50"
          >
            Reindex repository
          </button>
        </div>
      </div>
      {knowledgeMatches.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {knowledgeMatches.map((match) => (
            <article
              key={`${match.sourcePath}-${match.chunkIndex}`}
              className="border border-ink/10 bg-white p-5 shadow-panel"
            >
              <div className="flex items-center justify-between gap-3 font-mono text-[9px]">
                <span className="truncate font-bold text-cyan-800">
                  {match.sourcePath}#{match.chunkIndex}
                </span>
                <span className="shrink-0 bg-signal px-2 py-1 text-ink">
                  {Math.round(match.score * 100)}%
                </span>
              </div>
              <p className="mt-4 line-clamp-6 whitespace-pre-wrap text-xs leading-5 text-slate-600">
                {match.content}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
