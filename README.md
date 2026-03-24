# github-channels

Claude Code plugin that streams GitHub webhook events into your session in real-time. Push, PR, issue, CI — perceived as they happen, not polled.

## Install

```bash
claude plugins add mlops-kelvin/github-channels
```

That's it. The plugin registers its MCP server automatically. On first run, it:
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

The server binds to `127.0.0.1:8789` (localhost only). Your reverse proxy (Angie, nginx, Caddy) must forward `/webhook` to it so GitHub can deliver events.

## Start Claude Code

```bash
claude --dangerously-load-development-channels server:github-channels
```

This tells Claude Code to treat the plugin's MCP server as a channel server. Without this flag, events won't stream into your session.

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
| `no MCP server configured` | Plugin not installed or not loaded |
| `mcp_connected: false` | Missing `--dangerously-load-development-channels server:github-channels` flag |
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

## Migration from .env

If you have an existing `.env` file in the repo, it still works. The plugin checks:
1. `~/.claude/channels/github-channels/config.json` (new)
2. `.env` in the repo directory (legacy)
3. `GITHUB_WEBHOOK_SECRET` environment variable

To migrate: copy your `.env` values into `config.json` format, then delete the `.env`.

## Development

```bash
bun test
bun run dev
```

## License

MIT — Marbell AG
