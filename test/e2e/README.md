# E2E verification suites

Playwright scripts run against a local `wrangler dev --port 8791 --local` with
the local D1 rebuilt via `scripts/reset-local-db.sh`. Test login:
sitetest@test.com / testpass123 (register once on a fresh DB).

    cd test/e2e && npm i playwright && node verify-<suite>.mjs
