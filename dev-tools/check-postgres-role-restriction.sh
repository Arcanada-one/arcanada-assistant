#!/usr/bin/env bash
# ARCA-0039 — assistant_app must not run with SUPERUSER/CREATEROLE/CREATEDB.
#
# Static gate: asserts (1) docker-compose.yml mounts the initdb restriction
# script read-only, and (2) the script actually strips the three privileges.
# Does NOT connect to a running Postgres — see README.md § Security for the
# live-DB verification step (init scripts only run on first boot of an
# empty volume, so an already-initialized PROD role needs the manual
# runbook step documented there).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

fail=0

if ! grep -qE '\./ops/postgres-init:/docker-entrypoint-initdb\.d:ro' docker-compose.yml; then
  echo "FAIL: docker-compose.yml does not mount ops/postgres-init read-only into /docker-entrypoint-initdb.d" >&2
  fail=1
fi

SQL_FILE="ops/postgres-init/01-restrict-role.sql"
if [[ ! -f "$SQL_FILE" ]]; then
  echo "FAIL: $SQL_FILE missing" >&2
  fail=1
elif ! grep -qE 'ALTER ROLE assistant_app WITH NOSUPERUSER NOCREATEROLE NOCREATEDB' "$SQL_FILE"; then
  echo "FAIL: $SQL_FILE does not strip SUPERUSER/CREATEROLE/CREATEDB from assistant_app" >&2
  fail=1
fi

if [[ "$fail" -eq 0 ]]; then
  echo "OK: assistant_app role-restriction init script present and wired into docker-compose.yml"
fi

exit "$fail"
