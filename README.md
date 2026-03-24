# github-channels

Claude Code plugin that streams GitHub webhook events into your session in real-time. Push, PR, issue, CI — perceived as they happen, not polled.

## Install

```bash
# Add the marketplace (one-time)
claude plugins marketplace add mlops-kelvin/github-channels

# Install the plugin
claude plugins install github-channels
```

Restart Claude Code after installing. The plugin registers its MCP server automatically. On first run, it:
- Creates a config template at `~/.claude/channels/github-channels/config.json`
- Auto-generates a webhook secret at `~/.github-channels-secret`

## Configure

Edit `~/.claude/channels/github-channels/config.json`:

```json
{
  "port": 8789,
  "repos": ["owner/repo-a", "owner/repo-b"],
  "events": ["push", "pull_request", "issues", "issue_comment", "pull_request_review"],
  "trusted_actors": ["your-username", "teammate"],
  "channel_tip": "Tip: curl -X POST localhost:8789/mute/owner/repo?hours=5 to mute a noisy repo."
}
```

### Set up GitHub webhooks

On each monitored repo: Settings > Webhooks > Add webhook

- **Payload URL**: `https://your-domain.com/webhook`
- **Content type**: `application/json`
- **Secret**: contents of `~/.github-channels-secret`
- **Events**: select the events matching your config

### Reverse proxy

The server binds to `127.0.0.1:8789` (localhost only). A reverse proxy must forward `/webhook` to it so GitHub can deliver events. TLS termination happens at the proxy, not the plugin.

**Angie / nginx:**

```nginx
location /webhook {
    proxy_pass http://127.0.0.1:8789/webhook;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Only allow POST (webhooks are always POST)
    limit_except POST { deny all; }
}
```

**Security hardening** (optional but recommended):

- Restrict to [GitHub's webhook IP ranges](https://api.github.com/meta) (`hooks` key) at the proxy level
- Add rate limiting at the proxy (`limit_req_zone` in nginx/Angie)
- Never expose port 8789 directly to the internet — always proxy

**Verify the proxy works:**

```bash
# Should return 401 (invalid signature) — proves the proxy forwards to the server
curl -X POST https://your-domain.com/webhook -H "Content-Type: application/json" -d '{}'
```

## Start Claude Code

```bash
claude --dangerously-load-development-channels plugin:github-channels@github-channels
```

This tells Claude Code to treat the plugin's MCP server as a development channel. Without this flag, the MCP server runs but events won't stream into your session.

**With Discord plugin** (both channels active):

```bash
claude --dangerously-load-development-channels plugin:github-channels@github-channels --channels plugin:discord@claude-plugins-official
```

- `--dangerously-load-development-channels`: for third-party plugins (bypasses Anthropic's channel allowlist)
- `--channels`: for official plugins (on the allowlist)

## Verify

```bash
curl localhost:8789/status
```

Check:
- `mcp_connected: true` — Claude Code has connected
- `channels_ready: true` — events will flow
- `counts.delivered` — number of events pushed to your session

## Control

```bash
curl -X POST localhost:8789/mute                       # mute all
curl -X POST localhost:8789/unmute                     # unmute all
curl -X POST localhost:8789/mute/owner/repo?hours=5    # mute repo for 5h
curl -X POST localhost:8789/unmute/owner/repo          # unmute repo
curl -X POST localhost:8789/mute-all?hours=8           # mute all repos for 8h
curl -X POST localhost:8789/unmute-all                 # unmute everything
```

## Event Format

```
<channel source="github" event_type="push" repo="owner/repo" author="username" trust_tier="team" action="">
username pushed 3 commit(s) to owner/repo/main
  - Fix login validation
  - Update tests
  - Bump version
</channel>
```

### Supported Events

| Event | Trigger |
|-------|---------|
| `push` | Commits pushed |
| `pull_request` | PR opened, closed, merged, synced |
| `issues` | Issue opened, closed, labeled |
| `issue_comment` | Comment on issue or PR |
| `pull_request_review` | PR review submitted |
| `check_run` | CI check completed |
| `workflow_run` | GitHub Actions completed |
| `release` | Release published |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `no MCP server configured` | Plugin not installed — run `claude plugins install github-channels` |
| `mcp_connected: false` | Missing `--dangerously-load-development-channels plugin:github-channels@github-channels` flag |
| `not on the approved channels allowlist` | Used `--channels` instead of `--dangerously-load-development-channels` for this plugin |
| `counts.received: 0` | Webhooks not reaching server — check GitHub deliveries tab and reverse proxy |
| 401 on webhook | Secret mismatch — `~/.github-channels-secret` must match GitHub webhook config |
| 403 on webhook | Repo not in `repos` list in config.json |
| 503 on webhook | MCP handshake incomplete — restart Claude Code |

## Security

- HMAC-SHA256 verification on every webhook (secret required)
- Server binds to localhost only
- Trust tiers: `team` (in `trusted_actors`) vs `external` (everyone else)
- Content truncated to 2000 chars to prevent context flooding
- Agent instructions include prompt injection response protocol

## Development

```bash
bun test
bun run dev
```

## License

MIT — Marbell AG
