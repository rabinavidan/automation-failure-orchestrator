/**
 * Jira adapter — delegates to mock or real Jira based on INTEGRATION_MODE env var.
 */

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  labels: string[];
}

export interface CreateIssueParams {
  summary: string;
  description: string;
  labels: string[];
  priority?: string;
}

async function jiraRequest(path: string, options: RequestInit = {}): Promise<unknown> {
  const baseUrl = process.env.JIRA_BASE_URL ?? 'http://localhost:3002';
  const url = `${baseUrl}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira request failed: ${response.status} ${text}`);
  }

  return response.json();
}

export async function searchByLabel(label: string): Promise<JiraIssue | null> {
  try {
    const jql = `labels = "${label}"`;
    const result = await jiraRequest(
      `/jira/rest/api/2/search?jql=${encodeURIComponent(jql)}`
    ) as { issues: Array<{ key: string; fields: { summary: string; status: { name: string }; labels: string[] } }> };

    if (result.issues.length === 0) return null;

    const issue = result.issues[0];
    return {
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      labels: issue.fields.labels,
    };
  } catch (err) {
    console.error('[Jira] Search error:', err);
    return null;
  }
}

export async function createIssue(params: CreateIssueParams): Promise<string | null> {
  try {
    const body = {
      fields: {
        summary: params.summary,
        description: params.description,
        issuetype: { name: 'Bug' },
        project: { key: process.env.JIRA_PROJECT_KEY ?? 'AUTO' },
        labels: params.labels,
        priority: { name: params.priority ?? 'Medium' },
      },
    };

    const result = await jiraRequest('/jira/rest/api/2/issue', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as { key: string };

    return result.key;
  } catch (err) {
    console.error('[Jira] Create issue error:', err);
    return null;
  }
}

export async function addComment(issueKey: string, body: string): Promise<boolean> {
  try {
    await jiraRequest(`/jira/rest/api/2/issue/${issueKey}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    return true;
  } catch (err) {
    console.error(`[Jira] Add comment error (${issueKey}):`, err);
    return false;
  }
}
