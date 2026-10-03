import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface Runbook {
  /** File name, used as the citation id (e.g. `credential-brute-force.md`). */
  file: string;
  title: string;
  techniques: string[];
  content: string;
}

const DEFAULT_RUNBOOK_DIR = join(__dirname, '../../../../docs/runbooks');
const FALLBACK = 'fallback';

export function parseRunbook(file: string, content: string): Runbook {
  const title =
    content
      .match(/^#\s+(.+)$/m)?.[1]
      ?.replace(/^Runbook:\s*/, '')
      .trim() ?? file;
  const techniques = (content.match(/^Techniques:\s*(.+)$/m)?.[1] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return { file, title, techniques, content };
}

let cache: Runbook[] | null = null;

export function loadRunbooks(dir: string = process.env.SOC_RUNBOOK_DIR ?? DEFAULT_RUNBOOK_DIR) {
  if (cache && dir === (process.env.SOC_RUNBOOK_DIR ?? DEFAULT_RUNBOOK_DIR)) return cache;
  let runbooks: Runbook[] = [];
  try {
    runbooks = readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .sort()
      .map((f) => parseRunbook(f, readFileSync(join(dir, f), 'utf-8')));
  } catch (err) {
    console.warn('[Runbooks] could not load runbooks:', err instanceof Error ? err.message : err);
  }
  cache = runbooks;
  return runbooks;
}

export function resetRunbookCache(): void {
  cache = null;
}

/**
 * Deterministic runbook selection by ATT&CK technique (parent-technique match,
 * so T1110.001 selects a runbook declaring T1110). Falls back to the generic
 * triage runbook so the planner always has a grounded procedure to cite.
 */
export function selectRunbooks(techniques: string[], runbooks: Runbook[], max = 2): Runbook[] {
  const parents = new Set(techniques.map((t) => t.split('.')[0]));
  const matched = runbooks.filter((rb) =>
    rb.techniques.some((t) => t !== FALLBACK && parents.has(t.split('.')[0]))
  );
  if (matched.length > 0) return matched.slice(0, max);
  return runbooks.filter((rb) => rb.techniques.includes(FALLBACK)).slice(0, 1);
}
