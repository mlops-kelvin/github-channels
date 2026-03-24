#!/usr/bin/env bun
/**
 * GitHub Channels — MCP channel server for Claude Code.
 *
 * Receives GitHub webhook POSTs on a local HTTP port and pushes them
 * into Claude Code sessions as structured <channel> events via MCP.
 *
 * Configuration lives in .env (see .env.example).
 * Mute/unmute via HTTP: POST /mute, POST /unmute, GET /status
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { join } from "path";
import { createHmac, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ENV_FILE = join(import.meta.dir, ".env");

function loadEnv(): void {
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {}
}

loadEnv();

const PORT = parseInt(process.env.PORT || "8789", 10);
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const ALLOWED_REPOS = (process.env.GITHUB_REPOS || "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
const ALLOWED_EVENTS = (process.env.GITHUB_EVENTS || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

const CHANNEL_TIP = process.env.CHANNEL_TIP || "";

let muted = process.env.MUTED === "true";

// Per-repo mutes with optional expiry
const repoMutes = new Map<string, number | null>(); // repo → expiry timestamp (null = indefinite)

function isRepoMuted(repo: string): boolean {
  const expiry = repoMutes.get(repo);
  if (expiry === undefined) return false;
  if (expiry === null) return true; // indefinite
  if (Date.now() < expiry) return true;
  repoMutes.delete(repo); // expired — clean up
  return false;
}

function muteRepo(repo: string, hours?: number): void {
  repoMutes.set(repo, hours ? Date.now() + hours * 3600_000 : null);
}

function unmuteRepo(repo: string): boolean {
  return repoMutes.delete(repo);
}

function listMutedRepos(): Record<string, string> {
  const result: Record<string, string> = {};
  const now = Date.now();
  for (const [repo, expiry] of repoMutes) {
    if (expiry === null) {
      result[repo] = "indefinite";
    } else if (expiry > now) {
      const remaining = Math.ceil((expiry - now) / 3600_000 * 10) / 10;
      result[repo] = `${remaining}h remaining`;
    } else {
      repoMutes.delete(repo); // expired
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "github-channels", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions: [
      "GitHub webhook events arrive as <channel source=\"github\" event_type=\"...\" repo=\"...\" action=\"...\">.",
      "Each event contains a human-readable summary. The full payload is available in the content.",
      "",
      "Common event types: push, pull_request, issues, issue_comment, pull_request_review, check_run.",
      "React to events that are relevant to your current work. Ignore events that aren't.",
    ].join("\n"),
  }
);

// ---------------------------------------------------------------------------
// Webhook Signature Verification
// ---------------------------------------------------------------------------

function verifySignature(payload: string, signature: string | null): boolean {
  if (!WEBHOOK_SECRET) return true; // no secret configured = skip verification
  if (!signature) return false;

  const expected = "sha256=" +
    createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event Formatting
// ---------------------------------------------------------------------------

type GitHubPayload = Record<string, any>;

function formatSummary(eventType: string, payload: GitHubPayload): string {
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
      return `${sender} pushed ${count} commit(s) to ${repo}/${branch}\n${messages}`;
    }
    case "pull_request": {
      const pr = payload.pull_request || {};
      return `PR #${pr.number} ${action}: "${pr.title}" by ${sender} on ${repo}` +
        (pr.merged ? " [MERGED]" : "");
    }
    case "issues": {
      const issue = payload.issue || {};
      return `Issue #${issue.number} ${action}: "${issue.title}" by ${sender} on ${repo}`;
    }
    case "issue_comment": {
      const issue = payload.issue || {};
      const comment = payload.comment || {};
      const body = (comment.body || "").slice(0, 200);
      return `${sender} commented on ${repo}#${issue.number} ("${issue.title}"):\n${body}`;
    }
    case "pull_request_review": {
      const pr = payload.pull_request || {};
      const review = payload.review || {};
      return `${sender} ${review.state} PR #${pr.number} on ${repo}: "${pr.title}"`;
    }
    case "check_run": {
      const check = payload.check_run || {};
      return `Check "${check.name}" ${check.conclusion || check.status} on ${repo} (${check.head_sha?.slice(0, 7)})`;
    }
    case "workflow_run": {
      const run = payload.workflow_run || {};
      return `Workflow "${run.name}" ${run.conclusion || run.status} on ${repo}/${run.head_branch}`;
    }
    case "release": {
      const release = payload.release || {};
      return `Release ${release.tag_name} ${action} on ${repo} by ${sender}`;
    }
    default:
      return `GitHub event: ${eventType} ${action} on ${repo} by ${sender}`;
  }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    // Control endpoints
    if (req.method === "POST" && url.pathname === "/mute") {
      muted = true;
      return new Response(JSON.stringify({ muted: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (req.method === "POST" && url.pathname === "/unmute") {
      muted = false;
      return new Response(JSON.stringify({ muted: false }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return new Response(
        JSON.stringify({
          muted,
          mutedRepos: listMutedRepos(),
          repos: ALLOWED_REPOS,
          events: ALLOWED_EVENTS,
          port: PORT,
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // Per-repo mute: POST /mute/owner/repo?hours=5
    if (req.method === "POST" && url.pathname.startsWith("/mute/")) {
      const repo = url.pathname.slice("/mute/".length);
      if (!repo.includes("/")) {
        return new Response("invalid repo format — use owner/repo", { status: 400 });
      }
      const hours = url.searchParams.get("hours");
      muteRepo(repo, hours ? parseFloat(hours) : undefined);
      const msg = hours ? `muted ${repo} for ${hours}h` : `muted ${repo} indefinitely`;
      return new Response(JSON.stringify({ repo, muted: true, hours: hours || "indefinite" }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Per-repo unmute: POST /unmute/owner/repo
    if (req.method === "POST" && url.pathname.startsWith("/unmute/")) {
      const repo = url.pathname.slice("/unmute/".length);
      const was = unmuteRepo(repo);
      return new Response(JSON.stringify({ repo, muted: false, was_muted: was }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Mute all repos: POST /mute-all?hours=8
    if (req.method === "POST" && url.pathname === "/mute-all") {
      const hours = url.searchParams.get("hours");
      for (const repo of ALLOWED_REPOS) {
        muteRepo(repo, hours ? parseFloat(hours) : undefined);
      }
      muted = ALLOWED_REPOS.length === 0; // global mute if no repo allowlist
      const msg = hours ? `${hours}h` : "indefinite";
      return new Response(
        JSON.stringify({ muted_repos: ALLOWED_REPOS, hours: msg, global_mute: muted }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // Unmute all repos: POST /unmute-all
    if (req.method === "POST" && url.pathname === "/unmute-all") {
      repoMutes.clear();
      muted = false;
      return new Response(
        JSON.stringify({ cleared: true, global_mute: false }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // Webhook endpoint
    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }

    const body = await req.text();
    const signature = req.headers.get("x-hub-signature-256");
    const eventType = req.headers.get("x-github-event") || "unknown";

    // Verify signature
    if (!verifySignature(body, signature)) {
      return new Response("invalid signature", { status: 401 });
    }

    let payload: GitHubPayload;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    // Ping event (webhook setup verification)
    if (eventType === "ping") {
      return new Response(JSON.stringify({ ok: true, zen: payload.zen }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Filter: repo allowlist
    const repo = payload.repository?.full_name || "";
    if (ALLOWED_REPOS.length > 0 && !ALLOWED_REPOS.includes(repo)) {
      return new Response("repo not in allowlist", { status: 403 });
    }

    // Filter: event type
    if (ALLOWED_EVENTS.length > 0 && !ALLOWED_EVENTS.includes(eventType)) {
      return new Response("event type filtered", { status: 200 });
    }

    // Mute check (global then per-repo)
    if (muted) {
      return new Response("muted", { status: 200 });
    }
    if (isRepoMuted(repo)) {
      return new Response("repo muted", { status: 200 });
    }

    // Format and push to Claude Code session
    const summary = formatSummary(eventType, payload);
    const content = CHANNEL_TIP ? `${summary}\n\n${CHANNEL_TIP}` : summary;
    const action = payload.action || "";

    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content,
          meta: {
            event_type: eventType,
            repo,
            author: payload.sender?.login || "unknown",
            action,
            ...(payload.issue ? { issue_number: String(payload.issue.number) } : {}),
            ...(payload.pull_request ? { pr_number: String(payload.pull_request.number) } : {}),
          },
        },
      });
    } catch (err) {
      process.stderr.write(`github-channels: notification failed: ${err}\n`);
      return new Response("notification failed", { status: 500 });
    }

    return new Response("ok");
  },
});

process.stderr.write(
  `github-channels: listening on 127.0.0.1:${PORT}\n` +
    `  repos: ${ALLOWED_REPOS.length > 0 ? ALLOWED_REPOS.join(", ") : "(all)"}\n` +
    `  events: ${ALLOWED_EVENTS.length > 0 ? ALLOWED_EVENTS.join(", ") : "(all)"}\n` +
    `  muted: ${muted}\n`
);

// ---------------------------------------------------------------------------
// MCP Transport
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());
