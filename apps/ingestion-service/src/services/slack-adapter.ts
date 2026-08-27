/**
 * Slack adapter — sends notifications via incoming webhook.
 */
import { FailureClassification } from '@orchestrator/shared-types';

export interface SlackMessage {
  text: string;
  blocks?: unknown[];
}

export interface NotifyParams {
  classification: FailureClassification;
  testTitle: string;
  suite: string;
  fingerprint: string;
  jiraKey?: string;
  runId: string;
  branch: string;
  environment: string;
  errorMessage?: string;
  agentSummary?: string;
  agentConfidence?: number;
}

function classificationEmoji(c: FailureClassification): string {
  switch (c) {
    case FailureClassification.NewRegression:
      return ':red_circle:';
    case FailureClassification.KnownBug:
      return ':orange_circle:';
    case FailureClassification.FlakyTest:
      return ':yellow_circle:';
    case FailureClassification.InfrastructureFailure:
      return ':large_purple_circle:';
    case FailureClassification.AutomationFailure:
      return ':large_blue_circle:';
    case FailureClassification.PossiblyFixed:
      return ':large_green_circle:';
    default:
      return ':white_circle:';
  }
}

export async function sendSlackNotification(params: NotifyParams): Promise<boolean> {
  const webhookUrl =
    process.env.SLACK_WEBHOOK_URL ?? 'http://localhost:3002/slack/services/T00/B00/xxx';

  const emoji = classificationEmoji(params.classification);
  const jiraLink = params.jiraKey ? ` | Jira: *${params.jiraKey}*` : '';
  const errorSnippet = params.errorMessage
    ? `\n> \`${params.errorMessage.slice(0, 150)}\``
    : '';
  const agentSnippet = params.agentSummary
    ? `\n*AI investigation (${Math.round((params.agentConfidence ?? 0) * 100)}%):* ${params.agentSummary.slice(0, 300)}`
    : '';

  const message: SlackMessage = {
    text: `${emoji} *[${params.classification.toUpperCase()}]* ${params.testTitle}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `${emoji} *${params.classification.toUpperCase()}* detected`,
            `*Test:* ${params.testTitle}`,
            `*Suite:* ${params.suite}`,
            `*Branch:* \`${params.branch}\` | *Env:* ${params.environment}`,
            `*Run ID:* \`${params.runId.slice(0, 8)}\``,
            `*Fingerprint:* \`${params.fingerprint.slice(0, 12)}\`${jiraLink}`,
            errorSnippet,
            agentSnippet,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.error(`[Slack] Notification failed: ${response.status}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[Slack] Notification error:', err);
    return false;
  }
}
