#!/usr/bin/env bash
# Verify github-channels is working end-to-end.
# Run after setup to confirm channels are flowing.
set -euo pipefail

PORT="${1:-8789}"
BASE="http://127.0.0.1:${PORT}"

echo "=== github-channels verification ==="
echo ""

# Step 1: HTTP server reachable?
echo "[1/3] Checking HTTP server on port ${PORT}..."
if ! STATUS=$(curl -sf "${BASE}/status" 2>/dev/null); then
  echo "  FAIL: Cannot reach ${BASE}/status"
  echo "  Is the server running? Check: ss -tlnp | grep ${PORT}"
  exit 1
fi
echo "  OK: HTTP server responding"

# Step 2: MCP connected?
echo "[2/3] Checking MCP transport..."
MCP_CONNECTED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mcp_connected', 'missing'))" 2>/dev/null || echo "missing")
if [ "$MCP_CONNECTED" = "True" ] || [ "$MCP_CONNECTED" = "true" ]; then
  echo "  OK: MCP transport connected"
else
  echo "  FAIL: MCP transport not connected (mcp_connected=${MCP_CONNECTED})"
  echo "  Claude Code must be running with:"
  echo "    1. MCP server registered in .mcp.json"
  echo "    2. --dangerously-load-development-channels server:github-channels"
  echo "  Both are required. The flag references the MCP server by name."
  exit 1
fi

# Step 3: Send test webhook
echo "[3/3] Sending test webhook..."
# Read secret from .env in the script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/.env" ]; then
  SECRET=$(grep -oP '^GITHUB_WEBHOOK_SECRET=\K.*' "${SCRIPT_DIR}/.env" | tr -d "'\"")
else
  echo "  SKIP: No .env found at ${SCRIPT_DIR}/.env — cannot send test webhook"
  echo "  Manual test: push a commit to a monitored repo and check your Claude Code session"
  exit 0
fi

if [ -z "$SECRET" ]; then
  echo "  SKIP: GITHUB_WEBHOOK_SECRET is empty in .env"
  exit 0
fi

# Get first configured repo for the test payload
TEST_REPO=$(echo "$STATUS" | python3 -c "import sys,json; repos=json.load(sys.stdin).get('repos',[]); print(repos[0] if repos else 'test-org/test-repo')" 2>/dev/null)

BODY="{\"repository\":{\"full_name\":\"${TEST_REPO}\"},\"sender\":{\"login\":\"verify-script\"},\"action\":\"opened\",\"issue\":{\"number\":0,\"title\":\"github-channels verification test\",\"html_url\":\"https://github.com/${TEST_REPO}\"}}"
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"

RESPONSE=$(curl -sf -w "\n%{http_code}" -X POST "${BASE}/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issues" \
  -H "X-Hub-Signature-256: ${SIG}" \
  -d "$BODY" 2>/dev/null) || true

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_OUT=$(echo "$RESPONSE" | head -1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "  OK: Test event delivered (HTTP ${HTTP_CODE})"
  echo ""
  echo "=== VERIFIED ==="
  echo "Check your Claude Code session — you should see a test 'issues' event for ${TEST_REPO}."
elif [ "$HTTP_CODE" = "403" ]; then
  echo "  FAIL: Repo '${TEST_REPO}' not in allowlist (HTTP 403)"
  echo "  Check GITHUB_REPOS in .env"
  exit 1
elif [ "$HTTP_CODE" = "401" ]; then
  echo "  FAIL: Signature mismatch (HTTP 401)"
  echo "  The GITHUB_WEBHOOK_SECRET in .env may not match"
  exit 1
elif [ "$HTTP_CODE" = "503" ]; then
  echo "  FAIL: MCP not ready (HTTP 503)"
  echo "  The server is running but Claude Code hasn't connected yet"
  exit 1
else
  echo "  FAIL: Unexpected response (HTTP ${HTTP_CODE}): ${BODY_OUT}"
  exit 1
fi
