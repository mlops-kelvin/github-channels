---
description: Manage GitHub webhook channel — status, mute/unmute repos, view event counts
argument-hint: "[status | mute <repo> | unmute <repo> | mute-all | unmute-all | repos]"
allowed-tools: [Bash]
---

# /github-channels

Manage the github-channels webhook server from within Claude Code.

## Arguments

The user invoked: `/github-channels $ARGUMENTS`

## Instructions

Parse the arguments and execute the matching action. Default to `status` if no arguments provided.

### Determine the port

Read the port from the config file:

```bash
PORT=$(python3 -c "import json; print(json.load(open('$HOME/.claude/channels/github-channels/config.json')).get('port', 8789))" 2>/dev/null || echo 8789)
```

### Actions

**status** (default — no arguments):
```bash
curl -sf http://127.0.0.1:$PORT/status
```
Display the result as a markdown table:

| Field | Value |
|-------|-------|
| MCP Connected | true/false |
| Channels Ready | true/false |
| Global Mute | true/false |
| Events Received | N |
| Events Delivered | N |
| Events Filtered | N |
| Events Muted | N |
| Monitored Repos | repo1, repo2 |

If the curl fails, report: "github-channels server is not running on port $PORT."

**mute \<repo\>**:
```bash
curl -sf -X POST http://127.0.0.1:$PORT/mute/REPO
```
Report: "Muted REPO."

**unmute \<repo\>**:
```bash
curl -sf -X POST http://127.0.0.1:$PORT/unmute/REPO
```
Report: "Unmuted REPO."

**mute-all**:
```bash
curl -sf -X POST http://127.0.0.1:$PORT/mute-all
```
Report: "All repos muted."

**unmute-all**:
```bash
curl -sf -X POST http://127.0.0.1:$PORT/unmute-all
```
Report: "All repos unmuted."

**repos**:
```bash
curl -sf http://127.0.0.1:$PORT/status
```
Extract and display the repos list. Show muted status for each.

### Error handling

If the server is not reachable, display:
> github-channels server is not running on port $PORT. Start Claude Code with `--dangerously-load-development-channels server:github-channels`.
