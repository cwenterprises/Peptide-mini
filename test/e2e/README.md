# E2E verification suites

Playwright scripts run against a local `wrangler dev --port 8791 --local`.

    scripts/reset-local-db.sh            # fresh local state: clears .wrangler/state, applies all migrations
    npx wrangler dev --port 8791 --local # from the repo root, leave running
    cd test/e2e && npm i                 # once — Playwright pinned in package.json (uses the cached chromium)
    node verify-<suite>.mjs              # one suite
    npm test                             # every suite, stops at the first failure

Test login: sitetest@test.com / testpass123 — suites register it on a fresh DB.
Set `SHOTS=/some/dir` to save screenshots from suites that take them.

`.wrangler/` is local-only (gitignored). If `wrangler dev` dies with
`_cf_ALARM has 3 columns but 2 values were supplied`, run `scripts/reset-local-db.sh`.
