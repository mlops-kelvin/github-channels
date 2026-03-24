export type GitHubPayload = Record<string, any>;

const MAX_CONTENT_LENGTH = 2000;

function truncate(text: string, max = MAX_CONTENT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

export function formatSummary(eventType: string, payload: GitHubPayload): string {
  const repo = payload.repository?.full_name || "unknown";
  const sender = payload.sender?.login || "unknown";
  const action = payload.action || "";

  switch (eventType) {
    case "push": {
      const branch = (payload.ref || "").replace("refs/heads/", "");
      const commits = payload.commits || [];
      const count = commits.length;
      const messages = commits
        .slice(0, 5)
        .map((c: any) => `  - ${c.message.split("\n")[0]}`)
        .join("\n");
      return truncate(`${sender} pushed ${count} commit(s) to ${repo}/${branch}\n${messages}`);
    }
    case "pull_request": {
      const pr = payload.pull_request || {};
      return truncate(
        `PR #${pr.number} ${action}: "${pr.title}" by ${sender} on ${repo}` +
        (pr.merged ? " [MERGED]" : "")
      );
    }
    case "issues": {
      const issue = payload.issue || {};
      return truncate(`Issue #${issue.number} ${action}: "${issue.title}" by ${sender} on ${repo}`);
    }
    case "issue_comment": {
      const issue = payload.issue || {};
      const comment = payload.comment || {};
      const body = (comment.body || "").slice(0, 200);
      return truncate(`${sender} commented on ${repo}#${issue.number} ("${issue.title}"):\n${body}`);
    }
    case "pull_request_review": {
      const pr = payload.pull_request || {};
      const review = payload.review || {};
      return truncate(`${sender} ${review.state} PR #${pr.number} on ${repo}: "${pr.title}"`);
    }
    case "check_run": {
      const check = payload.check_run || {};
      return truncate(`Check "${check.name}" ${check.conclusion || check.status} on ${repo} (${check.head_sha?.slice(0, 7)})`);
    }
    case "workflow_run": {
      const run = payload.workflow_run || {};
      return truncate(`Workflow "${run.name}" ${run.conclusion || run.status} on ${repo}/${run.head_branch}`);
    }
    case "release": {
      const release = payload.release || {};
      return truncate(`Release ${release.tag_name} ${action} on ${repo} by ${sender}`);
    }
    default:
      return truncate(`GitHub event: ${eventType} ${action} on ${repo} by ${sender}`);
  }
}
