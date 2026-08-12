#!/usr/bin/env bash
# Rebuild the local D1 from all migrations. Fixes the recurring local drift
# (migration bookkeeping is broken; wrangler's migrations apply chokes on 0001).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf .wrangler/state/v3/d1
for f in migrations/*.sql; do
  echo "applying $f"
  npx wrangler d1 execute peptideos_db --local --file "$f" >/dev/null
done
echo "local D1 rebuilt from $(ls migrations/*.sql | wc -l | tr -d ' ') migrations"
