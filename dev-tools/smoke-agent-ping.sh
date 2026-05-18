#!/usr/bin/env bash
# ARCA-0009 M8 D2 — synthetic smoke ping (V-AC-8).
#
# Post-deploy CI step that probes /v1/agents/{name}/ping for each registered
# mesh agent and asserts state != 'unavailable'. Intended to run from a
# self-hosted runner against the live assistant. Fails fast on the first
# unavailable agent so deploys roll back deterministically.

set -euo pipefail

BASE_URL="${ASSISTANT_BASE_URL:-http://localhost:3800}"
API_KEY="${MESH_VAULT_API_KEY:-}"
AGENTS_DEFAULT=(transcriber munera dreamer knowledge ops-bot)
AGENTS=("${@:-${AGENTS_DEFAULT[@]}}")

if [[ -z $API_KEY ]]; then
  echo "MESH_VAULT_API_KEY not set — using unauthenticated probe (assumes /v1/agents/*/ping is public or runner is on tailnet)"
  AUTH_HEADER=()
else
  AUTH_HEADER=(-H "x-api-key: $API_KEY")
fi

fail=0
for agent in "${AGENTS[@]}"; do
  url="$BASE_URL/v1/agents/$agent/ping"
  body=$(curl -sS -o /tmp/smoke-agent-$$.json -w '%{http_code}' "${AUTH_HEADER[@]}" "$url" || true)
  if [[ ! $body =~ ^[0-9]+$ ]]; then
    echo "FAIL $agent — curl failed (no HTTP status)"
    fail=1
    continue
  fi
  state=$(jq -r '.state // "missing"' /tmp/smoke-agent-$$.json 2>/dev/null || echo missing)
  if [[ $state == 'unavailable' ]]; then
    echo "FAIL $agent — HTTP $body, state=$state"
    fail=1
  else
    echo "OK   $agent — HTTP $body, state=$state"
  fi
done
rm -f /tmp/smoke-agent-$$.json

if (( fail != 0 )); then
  echo "smoke-agent-ping: at least one agent unavailable — failing deploy"
  exit 1
fi
echo "smoke-agent-ping: all ${#AGENTS[@]} agents healthy"
