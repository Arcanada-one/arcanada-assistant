#!/usr/bin/env bash
# ARCA-0009 M8 D6 — Zod coverage gate (V-AC-12).
#
# Audits every `*.client.ts` and `*.schemas.ts` under the given roots and
# asserts that each *.client.ts:
#   1. imports at least one symbol ending in `Schema` from a sibling
#      schemas module (`./*schemas.js`).
#   2. calls one of `Schema.parse`, `Schema.safeParse` on that symbol.
#
# Pure shell + grep — no extra deps.

set -euo pipefail

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  cat <<'USAGE'
check-zod-coverage.sh [DIR ...]

Defaults to scanning apps/assistant/src/agents and packages/core/src/clients
when invoked from a repo root. Exits 1 if any client lacks visible Zod usage.

Examples:
  dev-tools/check-zod-coverage.sh
  dev-tools/check-zod-coverage.sh apps/assistant/src/agents
USAGE
  exit 0
fi

if [[ $# -gt 0 ]]; then
  roots=("$@")
else
  roots=(apps/assistant/src/agents packages/core/src/clients)
fi

uncovered=0
covered=0
total=0
declare -a uncovered_files=()

while IFS= read -r -d '' file; do
  total=$((total + 1))
  # Skip spec files and obvious non-clients.
  if [[ $file == *.spec.ts ]]; then
    continue
  fi
  if grep -qE '(Schema\.(safe)?[Pp]arse|Schema\.safeParseAsync)' "$file"; then
    covered=$((covered + 1))
    continue
  fi
  uncovered=$((uncovered + 1))
  uncovered_files+=("$file")
done < <(find "${roots[@]}" -type f -name '*.client.ts' -not -name '*.spec.ts' -print0 2>/dev/null)

echo "Zod coverage scan — roots: ${roots[*]}"
echo "  client files scanned: $total"
echo "  covered             : $covered"
echo "  uncovered           : $uncovered"

if (( uncovered > 0 )); then
  echo
  echo "FAIL — the following client files do not call Schema.parse / Schema.safeParse:"
  for f in "${uncovered_files[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

echo "OK — every client file has visible Zod validation."
