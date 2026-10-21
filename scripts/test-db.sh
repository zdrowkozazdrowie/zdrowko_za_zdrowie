#!/usr/bin/env bash
# Runs SQL tests from tests/db against a database (default: local Supabase started with `supabase start`).
# Each test file runs in a transaction that is rolled back, so the database is left untouched.
set -euo pipefail

cd "$(dirname "$0")/../tests/db"

if [[ -z "${DB_URL:-}" ]]; then
  # Local Supabase: supabase_admin is a superuser (needed to simulate pg_net responses); fall back to postgres.
  for candidate in \
    "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres" \
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres"; do
    if psql "$candidate" -X -qtAc 'select 1' >/dev/null 2>&1; then DB_URL="$candidate"; break; fi
  done
fi
: "${DB_URL:?Cannot connect to the database. Run 'supabase start' or set DB_URL.}"

failed=0
passed=0
for file in [0-9]*.sql; do
  echo "▶ ${file}"
  if output=$(psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -o /dev/null -f "$file" 2>&1); then
    count=$(grep -c 'NOTICE:  ok - ' <<<"$output" || true)
    passed=$((passed + count))
    sed -n 's/.*NOTICE:  ok - \(.*\)/  ✓ \1/p' <<<"$output"
  else
    sed -n 's/.*NOTICE:  ok - \(.*\)/  ✓ \1/p' <<<"$output"
    grep -v 'NOTICE:  ok - ' <<<"$output" | sed 's/^/  ✗ /'
    failed=1
  fi
done

echo
if [[ $failed -ne 0 ]]; then
  echo "Database tests FAILED"
  exit 1
fi
echo "Database tests passed (${passed} assertions)"
