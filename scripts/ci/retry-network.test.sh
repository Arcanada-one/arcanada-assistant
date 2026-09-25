#!/usr/bin/env bash
# A2-371 — the retry wrapper must retry a network failure and must NOT retry anything else.
# Each case states what a wrong wrapper would do, so a green run means the red one was possible.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/retry-network.sh"
export RETRY_NETWORK_DELAY_S=0
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
fails=0

check() { # name expected_rc expected_calls actual_rc actual_calls
  if [ "$2" = "$4" ] && [ "$3" = "$5" ]; then
    echo "ok   $1 (rc=$4 calls=$5)"
  else
    echo "FAIL $1: expected rc=$2 calls=$3, got rc=$4 calls=$5"
    fails=$((fails + 1))
  fi
}

# A fake command: fails with <message> for the first <n> calls, then succeeds. Counts its calls.
fake() { # name n message rc
  cat >"$scratch/$1" <<EOF
#!/usr/bin/env bash
c=\$(( \$(cat "$scratch/$1.calls" 2>/dev/null || echo 0) + 1 ))
echo "\$c" >"$scratch/$1.calls"
if [ "\$c" -le $2 ]; then echo "$3"; exit $4; fi
echo "done"
EOF
  chmod +x "$scratch/$1"
}
calls() { cat "$scratch/$1.calls" 2>/dev/null || echo 0; }

# The 2026-09-23 failure, verbatim: must be retried and recover.
fake econnreset 1 " ECONNRESET  request to https://registry.npmjs.org/json-schema-traverse/-/json-schema-traverse-1.0.0.tgz failed, reason: Client network socket disconnected before secure TLS connection was established" 1
"$SUT" 3 "$scratch/econnreset" >/dev/null 2>&1; rc=$?
check "network flake is retried and recovers" 0 2 "$rc" "$(calls econnreset)"

# A real audit finding: exit on the first attempt with pnpm's own rc. A blind retry loop calls it 3x.
fake finding 99 "1 vulnerabilities found
Severity: 1 high" 1
"$SUT" 3 "$scratch/finding" >/dev/null 2>&1; rc=$?
check "audit finding is NOT retried" 1 1 "$rc" "$(calls finding)"

# A lockfile mismatch is an answer, not a flake.
fake lockfile 99 " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile" 1
"$SUT" 3 "$scratch/lockfile" >/dev/null 2>&1; rc=$?
check "lockfile error is NOT retried" 1 1 "$rc" "$(calls lockfile)"

# A persistent outage: bounded, and the command's rc survives.
fake outage 99 "getaddrinfo EAI_AGAIN registry.npmjs.org" 7
"$SUT" 3 "$scratch/outage" >/dev/null 2>&1; rc=$?
check "persistent outage stops at max attempts" 7 3 "$rc" "$(calls outage)"

# Success first time: one call.
fake clean 0 "" 0
"$SUT" 3 "$scratch/clean" >/dev/null 2>&1; rc=$?
check "success is not repeated" 0 1 "$rc" "$(calls clean)"

# Bad usage is refused, not run.
"$SUT" 0 true >/dev/null 2>&1; rc=$?
check "zero attempts is a usage error" 2 0 "$rc" 0

if [ "$fails" -ne 0 ]; then
  echo "retry-network: $fails case(s) failed"
  exit 1
fi
echo "retry-network: all cases pass"
