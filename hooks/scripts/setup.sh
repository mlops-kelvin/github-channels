#!/usr/bin/env bash
# github-channels SessionStart hook — idempotent auto-setup.
# Runs every session start. Safe to re-run. Fails loudly on invalid config.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SECRET_FILE="$HOME/.github-channels-secret"
CONFIG_DIR="$HOME/.claude/channels/github-channels"
CONFIG_FILE="$CONFIG_DIR/config.json"

# Collect status for structured output
STATUS=()
WARNINGS=()

# --- Step 1: Install dependencies if missing ---

if [ ! -d "$PLUGIN_ROOT/node_modules" ]; then
  cd "$PLUGIN_ROOT"
  bun install --no-summary 2>/dev/null
  STATUS+=("deps: installed")
else
  STATUS+=("deps: ok")
fi

# --- Step 2: Generate webhook secret if missing ---

if [ ! -f "$SECRET_FILE" ]; then
  SECRET=$(openssl rand -hex 20)
  echo "$SECRET" > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  STATUS+=("secret: generated at $SECRET_FILE")
else
  STATUS+=("secret: ok")
fi

# --- Step 3: Create config template if missing ---

if [ ! -f "$CONFIG_FILE" ]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" <<'TEMPLATE'
{
  "port": 8789,
  "repos": [],
  "events": ["push", "pull_request", "issues", "issue_comment", "pull_request_review"],
  "trusted_actors": [],
  "channel_tip": ""
}
TEMPLATE
  STATUS+=("config: created template at $CONFIG_FILE")
  WARNINGS+=("config: repos list is empty — edit $CONFIG_FILE to add monitored repos")
else
  # Validate: repos must be non-empty
  REPOS_COUNT=$(python3 -c "import json; print(len(json.load(open('$CONFIG_FILE')).get('repos',[])))" 2>/dev/null || echo "0")
  if [ "$REPOS_COUNT" = "0" ]; then
    WARNINGS+=("config: repos list is empty — no webhooks will be accepted until repos are configured in $CONFIG_FILE")
  fi
  STATUS+=("config: ok ($REPOS_COUNT repos)")
fi

# --- Step 4: Check port availability ---

PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('port', 8789))" 2>/dev/null || echo "8789")
if ss -tlnp 2>/dev/null | grep -q ":${PORT} " && ! ss -tlnp 2>/dev/null | grep ":${PORT} " | grep -q "bun"; then
  WARNINGS+=("port: $PORT is already in use by another process")
fi

# --- Output structured result ---

echo "github-channels setup complete"
for s in "${STATUS[@]}"; do
  echo "  $s"
done
if [ ${#WARNINGS[@]} -gt 0 ]; then
  for w in "${WARNINGS[@]}"; do
    echo "  WARNING: $w" >&2
  done
fi
