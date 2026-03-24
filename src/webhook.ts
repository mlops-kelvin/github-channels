import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PORT, ALLOWED_REPOS, ALLOWED_EVENTS, TRUSTED_ACTORS, CHANNEL_TIP } from "./config.ts";
import { isGlobalMuted, setGlobalMute, isRepoMuted, muteRepo, unmuteRepo, muteAll, unmuteAll, listMutedRepos, getEventCounts, incrementCount } from "./mute.ts";
import { formatSummary, type GitHubPayload } from "./format.ts";
import { verifySignature } from "./verify.ts";

export function startWebhookServer(mcp: Server, isReady: () => boolean): void {
  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      // --- Control endpoints ---

      if (req.method === "POST" && url.pathname === "/mute") {
        setGlobalMute(true);
        return json({ muted: true });
      }
      if (req.method === "POST" && url.pathname === "/unmute") {
        setGlobalMute(false);
        return json({ muted: false });
      }
      if (req.method === "GET" && url.pathname === "/status") {
        return json({
          muted: isGlobalMuted(),
          mutedRepos: listMutedRepos(),
          repos: ALLOWED_REPOS,
          events: ALLOWED_EVENTS,
          port: PORT,
          counts: getEventCounts(),
        });
      }
      if (req.method === "POST" && url.pathname.startsWith("/mute/")) {
        const repo = url.pathname.slice("/mute/".length);
        if (!repo.includes("/")) {
          return new Response("invalid repo format — use owner/repo", { status: 400 });
        }
        const hours = url.searchParams.get("hours");
        muteRepo(repo, hours ? parseFloat(hours) : undefined);
        return json({ repo, muted: true, hours: hours || "indefinite" });
      }
      if (req.method === "POST" && url.pathname.startsWith("/unmute/")) {
        const repo = url.pathname.slice("/unmute/".length);
        const was = unmuteRepo(repo);
        return json({ repo, muted: false, was_muted: was });
      }
      if (req.method === "POST" && url.pathname === "/mute-all") {
        const hours = url.searchParams.get("hours");
        muteAll(hours ? parseFloat(hours) : undefined);
        return json({ muted_repos: ALLOWED_REPOS, hours: hours || "indefinite", global_mute: isGlobalMuted() });
      }
      if (req.method === "POST" && url.pathname === "/unmute-all") {
        unmuteAll();
        return json({ cleared: true, global_mute: false });
      }

      // --- Webhook endpoint ---

      if (req.method !== "POST" || url.pathname !== "/webhook") {
        return new Response("not found", { status: 404 });
      }
      if (!isReady()) {
        return new Response("MCP not ready", { status: 503 });
      }

      const body = await req.text();
      const signature = req.headers.get("x-hub-signature-256");
      const eventType = req.headers.get("x-github-event") || "unknown";

      if (!verifySignature(body, signature)) {
        return new Response("invalid signature", { status: 401 });
      }

      let payload: GitHubPayload;
      try {
        payload = JSON.parse(body);
      } catch {
        return new Response("invalid json", { status: 400 });
      }

      if (eventType === "ping") {
        return json({ ok: true, zen: payload.zen });
      }

      incrementCount("received");

      const repo = payload.repository?.full_name || "";
      if (ALLOWED_REPOS.length > 0 && !ALLOWED_REPOS.includes(repo)) {
        incrementCount("filtered");
        return new Response("repo not in allowlist", { status: 403 });
      }
      if (ALLOWED_EVENTS.length > 0 && !ALLOWED_EVENTS.includes(eventType)) {
        incrementCount("filtered");
        return new Response("event type filtered", { status: 200 });
      }
      if (isGlobalMuted()) {
        incrementCount("muted");
        return new Response("muted", { status: 200 });
      }
      if (isRepoMuted(repo)) {
        incrementCount("muted");
        return new Response("repo muted", { status: 200 });
      }

      const summary = formatSummary(eventType, payload);
      const content = CHANNEL_TIP ? `${summary}\n\n${CHANNEL_TIP}` : summary;
      const actor = (payload.sender?.login || "unknown").toLowerCase();
      const trustTier = TRUSTED_ACTORS.has(actor) ? "team" : "external";

      incrementCount("delivered");

      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content,
            meta: {
              event_type: eventType,
              repo,
              author: payload.sender?.login || "unknown",
              trust_tier: trustTier,
              action: payload.action || "",
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
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
}
