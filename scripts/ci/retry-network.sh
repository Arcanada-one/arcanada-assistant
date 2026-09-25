#!/usr/bin/env bash
# A2-371 — re-run a network-bound CI command, but ONLY when it failed on the network.
#
# Why this exists. On 2026-09-23 the `audit` job of CI on main (f3ab0d7, run 35915400301) died in
# `pnpm install` on `ECONNRESET` from registry.npmjs.org after pnpm's own per-request retries were
# spent (10 s, then 1 min). `smoke`, `deploy` and `verify` all `need` audit, so all three were
# skipped, nobody re-ran the run, and main stood undeployed for two days. A registry hiccup is not
# a verdict about the code, and it must not be able to cancel a release.
#
# Why not simply `for i in 1 2 3; do cmd && break; done`. `pnpm audit` exits non-zero both when the
# registry is unreachable AND when it finds a vulnerability. A blind retry would ask the question a
# second and a third time and could, with a flaky advisory endpoint, turn a real finding into a
# pass. So a retry happens only when the output carries a network-error signature AND the command
# failed; any other failure — a finding, a lockfile mismatch, a typo — is returned on the first
# attempt with its own exit code. The security gate (security-policy-mandate: `pnpm audit
# --audit-level=high --prod` is the CI floor) is therefore not weakened, only made to answer.
#
# Usage: retry-network.sh <max-attempts> <command> [args...]
#   RETRY_NETWORK_DELAY_S   seconds before attempt 2; doubles per attempt (default 20)
set -uo pipefail

if [ "$#" -lt 2 ] || ! [[ "$1" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: retry-network.sh <max-attempts> <command> [args...]" >&2
  exit 2
fi
max_attempts="$1"
shift
delay="${RETRY_NETWORK_DELAY_S:-20}"

# Signatures of a transport failure, as npm/pnpm/node print them. Deliberately NOT here: an audit
# finding, `ERR_PNPM_OUTDATED_LOCKFILE`, HTTP 4xx — those are answers, not an absent answer.
# (`ERR_PNPM_AUDIT_BAD_RESPONSE` IS here: it is the advisory endpoint failing to answer, not a finding.)
# A retry never turns a failure into a pass by itself: a real finding printed next to a network
# signature fails again on the next attempt with the same exit code.
network_re='ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|ERR_SOCKET_TIMEOUT|socket hang up|network socket disconnected|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5[0-9][0-9]|ERR_PNPM_AUDIT_BAD_RESPONSE|responded with 5[0-9][0-9]'

log="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/retry-network.XXXXXX")"
trap 'rm -f "$log"' EXIT

attempt=1
while :; do
  "$@" 2>&1 | tee "$log"
  rc="${PIPESTATUS[0]}"
  if [ "$rc" -eq 0 ]; then
    exit 0
  fi
  if ! grep -Eq "$network_re" "$log"; then
    echo "retry-network: '$*' failed with rc=${rc} and no network-error signature — not retried." >&2
    exit "$rc"
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "retry-network: '$*' failed on the network ${attempt}/${max_attempts} times (last rc=${rc}) — giving up." >&2
    exit "$rc"
  fi
  echo "::warning::retry-network: '$*' failed on the network (attempt ${attempt}/${max_attempts}, rc=${rc}); retrying in ${delay}s." >&2
  sleep "$delay"
  delay=$((delay * 2))
  attempt=$((attempt + 1))
done
