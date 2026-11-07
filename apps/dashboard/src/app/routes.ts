import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BookOpen,
  BrainCircuit,
  LayoutDashboard,
  MessageSquare,
  ShieldCheck,
  Siren,
  TicketCheck,
} from 'lucide-react';

export type View =
  | 'overview'
  | 'soc'
  | 'observability'
  | 'approvals'
  | 'knowledge'
  | 'investigations'
  | 'jira'
  | 'slack';

export const navItems: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'Command center', icon: LayoutDashboard },
  { id: 'soc', label: 'SOC console', icon: Siren },
  { id: 'observability', label: 'AI observability', icon: Activity },
  { id: 'approvals', label: 'Approval queue', icon: ShieldCheck },
  { id: 'knowledge', label: 'Knowledge RAG', icon: BookOpen },
  { id: 'investigations', label: 'AI investigations', icon: BrainCircuit },
  { id: 'jira', label: 'Jira activity', icon: TicketCheck },
  { id: 'slack', label: 'Slack signal', icon: MessageSquare },
];

const VIEWS = new Set<string>(navItems.map((item) => item.id));

function viewFromHash(): View {
  const id = window.location.hash.replace(/^#\/?/, '');
  return VIEWS.has(id) ? (id as View) : 'overview';
}

/**
 * The current view lives in the URL hash (`#/approvals`), so every view can be linked,
 * bookmarked and reached with the browser's back button. Hash routing needs no server
 * rewrite rule, so the Nginx image and the Vite dev server serve it unchanged.
 */
export function useHashRoute(): [View, (view: View) => void] {
  const [view, setViewState] = useState<View>(viewFromHash);

  useEffect(() => {
    const onHashChange = () => setViewState(viewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const setView = useCallback((next: View) => {
    if (viewFromHash() !== next) window.location.hash = `/${next}`;
    setViewState(next);
  }, []);

  return [view, setView];
}
