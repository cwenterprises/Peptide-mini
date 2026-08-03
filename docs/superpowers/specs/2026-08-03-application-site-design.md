# Application Site Tracking — Design

Date: 2026-08-03
Status: Approved (user), implemented same day

## Goal

Track where each dose was administered, modeled on the Pep AI reference
screenshot: a dashboard card with front/back body diagrams plus a
recent-sites list, and site capture when logging doses.

## Decisions (user-confirmed)

- **Picker**: dropdown *and* tappable body diagram (either sets the same field)
- **Card placement**: both Today and Dashboard tabs
- **Rotation**: suggest the least-recently-used site for the selected route
- **Routes**: all routes get a site field (nostrils for Intranasal,
  mouth for Oral, forearms/inner elbows for IV, body areas for Topical)

## Data model

- Migration `0007_application_site.sql`: `ALTER TABLE logs ADD COLUMN site TEXT;`
  Nullable — legacy doses and skipped picks display as "Site not recorded".
- Worker: `site` added to `logsAdd` INSERT and `logsUpdate` UPDATE;
  `logsList` uses `SELECT *` so it flows through unchanged.

## Frontend (index.html)

- **`SITES` registry** — single source of truth: `{key, label, view, x, y, routes}`.
  23 sites across front/back views. Drives the dropdown, diagram taps,
  card markers, and rotation logic. x/y are viewBox coords on 200×330 figures.
- **`bodyFigureSvg(view, overlay, width)`** — inline SVG silhouette
  (capsule limbs via round-cap strokes) reused by picker and card.
- **Log Dose form** — `ldSite` dropdown filtered by route, with a
  `<details>` collapsible diagram picker beneath. Two-way binding via
  `pickSite()` / `updateSitePicker()`. Route changes refilter in place
  (`refreshSiteOptions`, same Safari no-rebuild rule as vials).
- **Suggestion** — `suggestSiteKey(route, logs)`: least-recently-used
  applicable site; never-used sites win first in registry order.
  Marked "· suggested" in the dropdown + pulsing ring on the diagram.
- **Card** — `appSiteCardHtml(logs)`: front/back figures with one marker
  per site (opacity fades with age: ≤7d full, ≤30d 0.55, else 0.3) and
  the last 3 doses as "N days ago / site label / peptide" with a
  "Site not recorded" fallback. Header taps through to History.
- **History** — site label under the route cell; site column in CSV export.

## Verification

Playwright headless against `wrangler dev` + local D1: 12/12 checks
(card on both tabs, marker dots, route filtering, diagram↔dropdown
binding, suggestion, save/edit roundtrip, History display).
