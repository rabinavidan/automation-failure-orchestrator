import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { PlaybookSchema } from '@orchestrator/shared-types';
import type { AlertTriage, Playbook, TriagePriority } from '@orchestrator/shared-types';

const DEFAULT_PLAYBOOK_DIR = join(__dirname, '../../../../config/playbooks');
const PRIORITY_RANK: Record<TriagePriority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

export interface PlaybookLoadResult {
  playbooks: Playbook[];
  /** Files that failed validation are excluded (never partially executed) and reported. */
  errors: Array<{ file: string; error: string }>;
}

let cache: PlaybookLoadResult | null = null;

export function loadPlaybooks(
  dir: string = process.env.SOC_PLAYBOOK_DIR ?? DEFAULT_PLAYBOOK_DIR
): PlaybookLoadResult {
  const result: PlaybookLoadResult = { playbooks: [], errors: [] };
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort();
  } catch (err) {
    result.errors.push({ file: dir, error: err instanceof Error ? err.message : String(err) });
    return result;
  }

  const seen = new Set<string>();
  for (const file of files) {
    try {
      const parsed = PlaybookSchema.safeParse(parse(readFileSync(join(dir, file), 'utf-8')));
      if (!parsed.success) {
        const error = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        result.errors.push({ file, error });
      } else if (seen.has(parsed.data.id)) {
        result.errors.push({ file, error: `duplicate playbook id ${parsed.data.id}` });
      } else {
        seen.add(parsed.data.id);
        result.playbooks.push(parsed.data);
      }
    } catch (err) {
      result.errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const { file, error } of result.errors) {
    console.error(`[Playbooks] ${file} rejected: ${error}`);
  }
  return result;
}

export function getPlaybooks(): PlaybookLoadResult {
  cache ??= loadPlaybooks();
  return cache;
}

export function resetPlaybookCache(): void {
  cache = null;
}

export function playbookMatches(playbook: Playbook, triage: AlertTriage): boolean {
  const { dispositions, techniques, maxPriority } = playbook.trigger;
  if (!dispositions.includes(triage.disposition)) return false;
  if (maxPriority && PRIORITY_RANK[triage.priority] > PRIORITY_RANK[maxPriority]) return false;
  if (techniques && techniques.length > 0) {
    const parents = new Set(triage.mitre.techniques.map((t) => t.split('.')[0]));
    if (!techniques.some((t) => parents.has(t.split('.')[0]))) return false;
  }
  return true;
}

export function selectPlaybooks(playbooks: Playbook[], triage: AlertTriage): Playbook[] {
  return playbooks.filter((p) => playbookMatches(p, triage));
}
