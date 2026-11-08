import { useEffect } from 'react';
import { Bot, MessageSquare } from 'lucide-react';
import { getJson, useViewData } from '../../app/data';
import { useRefresh } from '../../app/refresh-context';
import type { SlackMessage } from '../../types';
import { EmptyState, LoadingState } from '../../ui/primitives';
import { formatTime } from '../../ui/format';

async function loadMessages(signal: AbortSignal): Promise<SlackMessage[]> {
  const payload = await getJson<{ messages?: SlackMessage[] }>('/api/mock/slack/messages', signal);
  return payload.messages ?? [];
}

/** Notifications the policy sent (the mock Slack in local and demo stacks). */
export function SlackSignal() {
  const { data, settled } = useViewData(loadMessages);
  const { setCount } = useRefresh();
  useEffect(() => {
    if (data) setCount('slack', data.length);
  }, [data, setCount]);

  if (!settled) return <LoadingState />;
  const messages = data ?? [];

  return (
    <section className="page-enter py-7">
      {messages.length === 0 ? (
        <EmptyState label="Slack notifications" />
      ) : (
        <div className="mx-auto max-w-4xl border border-ink/10 bg-white shadow-panel">
          <div className="flex items-center gap-3 border-b border-slate-200 bg-[#4a154b] p-5 text-white">
            <MessageSquare size={20} />
            <div>
              <h2 className="font-bold">#ci-failure-intelligence</h2>
              <p className="text-xs text-white/75">Automation signal stream</p>
            </div>
          </div>
          <div className="divide-y divide-slate-100">
            {[...messages].reverse().map((message) => {
              const body =
                message.payload.blocks?.[0]?.text?.text ??
                message.payload.text ??
                JSON.stringify(message.payload);
              return (
                <article key={message.id} data-testid="slack-message" className="flex gap-4 p-5">
                  <div className="grid h-10 w-10 shrink-0 place-items-center bg-ink text-signal">
                    <Bot size={19} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <p className="text-sm font-bold">SignalOps Agent</p>
                      <span className="font-mono text-[9px] text-slate-600">
                        {formatTime(message.receivedAt)}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                      {body.replaceAll('*', '').replaceAll('`', '')}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
