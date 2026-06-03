# Syringe Calculator + Peptide Auto-Seeding — Design Spec
**Date:** 2026-06-03
**Status:** Approved

---

## Overview

Two targeted improvements to PeptideOS:

1. **Peptide auto-seeding** — new user accounts start with 40 default peptides instead of an empty list.
2. **Syringe size selector** — session-scoped U-100/U-40 type and 0.3/0.5/1.0mL capacity selector in the Calculator and Log Dose tabs, with corrected IU math and overflow warnings.

---

## Part A: Peptide Auto-Seeding

### Problem
New accounts have an empty peptide dropdown. Users must navigate to Settings → Peptide List and click "Reset to Defaults" before the app is usable.

### Solution
Seed the 40 default peptides server-side during registration.

### Implementation

**`worker/index.js` — `authRegister`**

After inserting the new user row, insert all 40 default peptides in a single D1 batch statement before returning the session token.

```javascript
const DEFAULT_PEPTIDES = [
  "5-amino-1mq","AICAR","AOD-9604","ARA-290","Adalank","Adamax","BPC-157",
  "Cerebrolysin","CJC-1295","CJC-195/IPA","DSIP","Dihexa","Epithalon",
  "GHK-CU","GhRIP","Glow","Glutathione","IGF-1 LR3","Ipamorelin","KPV",
  "Kisspeptin","Klow","LL-37","Lipo-C","MOTS-C","NAD+","Oxytocin","PE-22-28",
  "PT-141","Pinealon","Retatrutide","SS-31","SLU-PP-332","Semax","Selank",
  "Sermorelin","TB-500","Tesamorelin","Thymosin Alpha-1","VIP","Wolverine"
];
```

Use `env.DB.batch([...statements])` to insert all peptides atomically with the user creation. If the batch fails, the user row should also not be created (wrap in a single batch or use a try/catch that deletes the user if seeding fails).

### Scope
- New registrations only. Existing users are unaffected.
- Does not change the frontend `DEFAULT_PEPTIDES` constant — it stays for the "Reset to Defaults" flow.

---

## Part B: Syringe Size Selector

### Session State

Two module-level JS variables initialized at page load. Not persisted to localStorage or the API — reset on every reload.

```javascript
let _syringeType = 100;       // 100 = U-100, 40 = U-40
let _syringeCapacityMl = 1.0; // 0.3, 0.5, or 1.0
```

### Syringe Options

| Type | IU per mL | Common use |
|------|-----------|------------|
| U-100 | 100 | Standard insulin syringe for peptides |
| U-40  | 40  | Older/veterinary insulin syringes |

| Capacity | Max volume | Total IU (U-100) |
|----------|-----------|-----------------|
| 0.3 mL | 0.3 mL | 30 IU |
| 0.5 mL | 0.5 mL | 50 IU |
| 1.0 mL | 1.0 mL | 100 IU |

### IU Formula (updated everywhere)

```javascript
const iu = volMl * _syringeType;  // replaces hardcoded volMl * 100
```

Affected locations:
- `calcRecon()` — Reconstitution sub-tab output
- `calcDraw()` — Draw sub-tab output
- `calcDrawMath()` — Log Dose draw math panel

Labels update from `"IU on U-100 syringe"` to `"IU on U-${_syringeType} syringe"`.

### Overflow Warning

When `volMl > _syringeCapacityMl`, show an amber inline badge immediately below the draw result:

```
⚠ Exceeds 0.5 mL syringe capacity
```

Warning is informational only — does not block saving or hide the result.

### UI: Calculator Tab

A glass card placed **above** the sub-tab nav pill containing two segmented pill selectors:

```
Syringe:  [U-100]  [U-40]      Capacity:  [0.3 mL]  [0.5 mL]  [1 mL]
```

Active option uses `btn-primary` style. Inactive options use `btn-ghost`. Changing either value:
1. Updates `_syringeType` or `_syringeCapacityMl`
2. Immediately calls the active sub-tab's recalculation function

### UI: Log Dose Draw Math Panel

Two compact `<select>` dropdowns inside the existing draw math glass card (after the "Draw math" label, before the result line):

- **Type**: `<select>` with options `U-100 (standard)` / `U-40`
- **Capacity**: `<select>` with options `0.3 mL` / `0.5 mL` / `1 mL`

Both bind to the same `_syringeType` and `_syringeCapacityMl` variables. Changing either calls `updateDrawMath()`.

The Calculator and Log Dose selectors stay in sync because they share the same module-level variables — changing one updates the other's displayed value if the user switches tabs.

### Files Changed

| File | Change |
|------|--------|
| `worker/index.js` | Add `DEFAULT_PEPTIDES` constant + batch insert in `authRegister` |
| `index.html` | Add `_syringeType`/`_syringeCapacityMl` state vars; update `calcRecon`, `calcDraw`, `calcDrawMath`; update `renderCalc` (add syringe glass card above sub-tabs), update `renderLogDose` (add compact selectors in draw math panel) |

---

## Out of Scope

- Saving syringe preference across sessions (not requested)
- Syringe size in the Cycle Cost or Half-Life sub-tabs (not relevant to draw volume)
- Custom syringe sizes (0.3/0.5/1.0 covers all common U-100 insulin syringes)
