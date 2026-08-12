# Apple Health Sync — Design

Date: 2026-08-12
Status: Approved (user), implemented same day

## Scope (user-confirmed)

Weight only, both directions. No dose→Health writes (no honest HealthKit
sample type for research peptides).

## Native (iOS wrapper)

- `HealthSync.swift`: in-app CAPBridgedPlugin (no pod) — isAvailable,
  requestAuth (share+read bodyMass), readWeights({sinceDays}) → [{date
  local-YMD, kg}], writeWeight({date, kg}) at local noon.
- `AppViewController: CAPBridgeViewController` registers the plugin in
  capacitorDidLoad; Main.storyboard customClass swapped to it.
- `App.entitlements` (com.apple.developer.healthkit) + CODE_SIGN_ENTITLEMENTS
  in both configs; NSHealthShare/UpdateUsageDescription in Info.plist.
- Signing: HEALTHKIT capability enabled on bundle id 95DTT47XA6 via ASC API
  (invalidated the old PeptideOSAppStore profile → deleted, recreated
  QQZCAN8RQZ with dist cert 4C4GDCL378, installed locally).

## JS glue (native-gated, zero web change)

- Settings "🍎 Apple Health" section (only when Capacitor native): Enable
  (requestAuth) / Disable, lb/kg unit picker; per-device localStorage
  (pepos_health_sync, pepos_health_unit).
- Pull: on first renderAllTabs when enabled, readWeights(60d) →
  `healthFillPlan` (pure): fills only days with no manual weight, last
  sample per day wins, converts kg→unit; PUT /checkins per fill.
- Push: saveCheckin fire-and-forgets writeWeight (unit→kg).

## Verification

- Simulator Debug build compiles clean (plugin + storyboard + entitlements).
- test/e2e/verify-health.mjs 8/8: conversions, fill-plan rules, web
  degradation (no section, helpers no-op).
- Device end-to-end (Health prompt, real samples) via TestFlight build 15.
