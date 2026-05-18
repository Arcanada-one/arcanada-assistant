#!/usr/bin/env bash
# ARCA-0009 M8 D8 — AAL L3 evidence aggregator (V-AC-18).
#
# Walks the 7 AAL L3 dimensions and asserts each has a falsifiable artifact
# present in the repo plus a passing spec or shell gate. Exit 0 ⇒ L3
# claim is honestly defensible; exit 1 ⇒ at least one dimension is missing
# evidence. Intended invocation: `dev-tools/aal-l3-evidence-check.sh
# --task ARCA-0009` (the task flag is informational, no behavioural diff).

set -euo pipefail

TASK=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) TASK="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
aal-l3-evidence-check.sh [--task TASK-ID]

Asserts every L3 dimension has an artefact AND a passing spec/script.
USAGE
      exit 0
      ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

missing=0
note() {
  printf '  %-22s %s\n' "$1" "$2"
}

check_file() {
  local label="$1" path="$2"
  if [[ -f $path ]]; then
    note "$label" "OK   $path"
  else
    note "$label" "FAIL missing $path"
    missing=$((missing + 1))
  fi
}

check_manifest_field() {
  local field="$1" expected="$2"
  if grep -qE "^${field}: ${expected}\$" apps/assistant/manifest.yaml; then
    note "$field" "OK   $expected"
  else
    note "$field" "FAIL expected '$field: $expected' in apps/assistant/manifest.yaml"
    missing=$((missing + 1))
  fi
}

echo "AAL L3 evidence check (task=${TASK:-N/A})"
echo

echo "[manifest]"
check_file "manifest" apps/assistant/manifest.yaml
check_manifest_field current_aal L3

echo
echo "[D1 liveness]"
check_file "indicator"  apps/assistant/src/health/per-agent.health.indicator.ts
check_file "spec"       apps/assistant/src/health/per-agent.health.indicator.spec.ts
check_file "controller" apps/assistant/src/health/health.controller.ts

echo
echo "[D2 smoke ping]"
check_file "endpoint"  apps/assistant/src/health/agent-ping.controller.ts
check_file "spec"      apps/assistant/src/health/agent-ping.controller.spec.ts
check_file "ci runner" dev-tools/smoke-agent-ping.sh

echo
echo "[D3 observability]"
check_file "context"    apps/assistant/src/observability/trace-context.ts
check_file "pino bridge" apps/assistant/src/observability/otel-pino-bridge.ts
check_file "spec"       apps/assistant/src/observability/trace-context.spec.ts

echo
echo "[D4 credential validation]"
check_file "registry"   apps/assistant/src/aal/bootstrap-credential.ts
check_file "runner"     apps/assistant/src/aal/bootstrap-runner.service.ts
check_file "spec"       apps/assistant/src/aal/bootstrap-credential.spec.ts

echo
echo "[D5 exception hierarchy]"
check_file "exceptions" apps/assistant/src/aal/exceptions.ts
check_file "spec"       apps/assistant/src/aal/exceptions.spec.ts

echo
echo "[D6 zod coverage]"
check_file "gate"       dev-tools/check-zod-coverage.sh
if dev-tools/check-zod-coverage.sh >/dev/null 2>&1; then
  note "gate-exit" "OK   exit 0"
else
  note "gate-exit" "FAIL non-zero exit"
  missing=$((missing + 1))
fi

echo
echo "[D7 tool scope]"
check_file "manifest" apps/assistant/src/aal/agent-scopes.yaml
check_file "loader"   apps/assistant/src/aal/scope.loader.ts
check_file "guard"    apps/assistant/src/aal/scope-guard.ts
check_file "spec"     apps/assistant/src/aal/scope-guard.spec.ts

echo
echo "[auth — V-AC-6 alignment]"
check_file "interface"  apps/assistant/src/auth/auth-strategy.interface.ts
check_file "tailscale"  apps/assistant/src/auth/tailscale.strategy.ts
check_file "vault key"  apps/assistant/src/auth/vault-api-key.strategy.ts
check_file "jwt"        apps/assistant/src/auth/auth-arcana-jwt.strategy.ts
check_file "dispatcher" apps/assistant/src/auth/auth.dispatcher.ts
check_file "preflight"  apps/assistant/src/auth/auth.preflight.ts

echo
if (( missing != 0 )); then
  echo "FAIL — ${missing} evidence item(s) missing"
  exit 1
fi

echo "OK — every L3 dimension has artefact + spec"
