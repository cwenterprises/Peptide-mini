# PeptideOS Revamp — Design Spec
**Date:** 2026-06-02  
**Status:** Approved

---

## Overview

Full revamp of the existing Peptide Mini single-file app into PeptideOS: a cloud-first, installable PWA with a premium liquid glass UI, multi-mode calculator suite, searchable peptide reference library, cross-device sync, email+password auth, and PWA push notifications.

---

## Design System

### Visual Language
- **Style:** Clinical/medical with liquid glass cards
- **Light mode (default):** Frosted white cards (`rgba(255,255,255,0.55)`) over soft blue radial-gradient background (`#e8f4fd`). Specular top-edge highlights, `backdrop-filter: blur(28px) saturate(180%)`, layered box-shadows for depth.
- **Dark mode:** Deep navy background (`#0a0f1e`) with subtle blue/indigo radial gradients. Glass cards use `rgba(255,255,255,0.06)` with matching specular highlights and stronger drop shadows.
- **Mode toggle:** Defaults to `prefers-color-scheme`. Manual override saved in localStorage. Toggle in Settings tab.
- **Accent palette:** Sky blue (`#0ea5e9`), Indigo (`#6366f1`), Green (`#16a34a`/`#4ade80` dark), Amber (`#d97706`/`#fbbf24` dark)
- **Typography:** `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif`
- **Buttons:** Primary uses `linear-gradient(135deg, #0ea5e9, #6366f1)` with glow shadow. Ghost buttons use frosted glass background.

### Glass Card Anatomy
```
border: 1px solid rgba(255,255,255,0.85)          ← outer rim
::before pseudo: top specular shimmer highlight    ← liquid effect
background: rgba(255,255,255,0.55) + backdrop-filter ← frosted body
box-shadow: outer depth + inset top highlight      ← layered depth
border-radius: 18–22px
```

---

## Architecture

### Stack
| Layer | Technology |
|---|---|
| Frontend | Single HTML file (`index.html`) — vanilla JS, no build step |
| API | Cloudflare Worker (`worker/index.js`) — handles all `/api/*` routes |
| Database | Cloudflare D1 (`peptideos_db`) — SQLite |
| Sessions | Cloudflare KV (`SESSIONS`) — token → user_id, 30-day TTL |
| Push subscriptions | D1 `push_subscriptions` table |
| Cron (reminders) | Cloudflare Cron Trigger on the Worker |
| Deploy | `wrangler deploy` — single command |
| Config | `wrangler.toml` — binds D1 + KV |

### D1 Schema
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE peptides (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL
);

CREATE TABLE planner (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  peptide TEXT NOT NULL,
  day INTEGER NOT NULL,        -- 0=Sun … 6=Sat
  time TEXT,                   -- HH:MM or null
  route TEXT NOT NULL,
  dose REAL NOT NULL,
  unit TEXT NOT NULL,
  note TEXT
);

CREATE TABLE vials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  peptide TEXT NOT NULL,
  mg REAL NOT NULL,
  ml REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  vial_id TEXT REFERENCES vials(id),
  peptide TEXT NOT NULL,
  route TEXT NOT NULL,
  dose_value REAL NOT NULL,
  dose_unit TEXT NOT NULL,
  dose_mcg REAL,
  volume_ml REAL,
  iu REAL,
  taken_at TEXT NOT NULL,      -- ISO 8601
  notes TEXT
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### Auth Flow
1. User submits email + password to `POST /api/auth/register` or `POST /api/auth/login`
2. Worker hashes password with PBKDF2 via Web Crypto API (100,000 iterations, SHA-256, 32-byte salt), stores `salt:hash` in D1 `users`
3. On login: re-derive hash with stored salt, compare, generate UUID session token, write `token → {user_id, expires_at}` to KV with 30-day TTL
4. Token returned to client, stored in `localStorage`
5. All subsequent API calls send `Authorization: Bearer <token>` header
6. Worker validates token against KV on every request

### Offline Support
- App shell (HTML/CSS/JS) cached by Service Worker on first load
- API mutations (log dose, add vial, add planner item) queued in IndexedDB when offline
- On reconnect, queued mutations are flushed to the API in order

---

## Navigation

Seven tabs in the top nav pill:

| Tab | Purpose |
|---|---|
| **Today** | Protocol progress for today, streak, quick-log buttons |
| **Week** | 7-day grid view with per-day done/pending counts |
| **Log Dose** | Manual dose entry form with live draw math |
| **Vials** | Add/manage vials, visual remaining % progress bars |
| **Calculator** | 4-mode calculator suite |
| **Library** | Searchable peptide reference database |
| **Settings** | Account, push notifications, theme toggle, peptide list, cycle dates, export |

---

## Features

### Today Tab
- Stat chips: Planned count, Done count, Streak (days consecutive ≥ 1 dose logged)
- Protocol card with progress bar (% of today's planned doses logged)
- Dose rows: peptide name, dose, route, scheduled time, DONE/PENDING badge
- One-tap "Log" button on pending items (pre-fills Log Dose form)
- Research use disclaimer at card bottom

### Week Tab
- 7-column grid starting from user-configured week start day
- Each column: day name, date, done/planned count, peptide name list
- Today's column highlighted with accent border

### Log Dose Tab
- Fields: Peptide (dropdown), Date/Time, Route, Dose value, Unit
- Vial selector (filtered to selected peptide) → live draw math (mL + IU)
- Notes textarea
- Save / Delete last buttons

### Vials Tab
- Add vial form: Peptide, mg, mL → auto-calculates concentration
- Active vials table with gradient progress bar (color shifts green→amber→red as depleted)
- Remaining mcg calculated from logs

### Calculator Tab — 4 Modes

**Mode 1: Reconstitution**
- Inputs: Vial size (mg), Diluent to add (mL)
- Outputs: Concentration (mcg/mL), Total mcg, Total mL
- Secondary: Desired dose (mcg) → Draw volume (mL) + IU on syringe

**Mode 2: Draw**
- Inputs: Concentration (mcg/mL), Desired dose (mcg or mg)
- Outputs: Volume (mL), IU on syringe
- Can select an existing vial to auto-populate concentration

**Mode 3: Cycle Cost**
- Inputs: Peptide, dose (mcg), frequency (times/week), cycle length (weeks), price per mg ($)
- Outputs: Total mcg needed, Total mg needed, Vials required (rounded up), Estimated cost

**Mode 4: Half-Life / Dosing Interval**
- Inputs: Select peptide (auto-fills half-life from library) or enter half-life manually
- Outputs: Time to 50%/25%/12.5% remaining, recommended minimum dosing interval, optimal daily dose schedule visualization

### Library Tab
- Search bar filters by name or alias
- Peptide cards showing: name, description, half-life, common dose range, route, "Research" badge
- Tapping a card opens detail view with: mechanism summary, common protocols, typical cycle length, stack notes
- "Use in Calculator" button pre-fills Calculator tab from library entry
- All entries marked with "Research purposes only" disclaimer

### Settings Tab
- **Account:** Email display, Change Password, Sign Out
- **Push Notifications:** Toggle (requests browser permission, saves Web Push subscription to API)
- **Theme:** Light / Dark / System toggle
- **Peptide List:** Add custom peptides, remove, reset to defaults (40 built-in)
- **Cycle Dates:** Start + End date inputs
- **Export:** Download all data as CSV (planner, vials, logs)
- **Danger Zone:** Delete all data (requires confirmation)

---

## PWA & Push Notifications

- `manifest.json`: app name "PeptideOS", icons, `display: standalone`, theme colors for light+dark
- `service-worker.js`: caches app shell, handles background sync for offline queue
- Push: Web Push API. Worker stores `PushSubscription` (endpoint, p256dh, auth) per user in D1
- Cloudflare Cron Trigger fires every 5 minutes, queries planner items due in the next 10 minutes, sends push via Web Push Protocol to all subscribed users
- Deduplication: `notifications_sent` table (user_id, planner_id, sent_date) prevents duplicate pushes for the same planner item on the same day

---

## Auth Screens

### Sign In
- Logo, email field, password field, "Forgot password?" link, Sign In button, link to Sign Up

### Create Account
- Logo, email, password, confirm password
- Two required checkboxes (both must be checked to enable submit):
  1. "I agree to the Terms of Service and Privacy Policy"
  2. "I understand this app is for personal tracking only and is not medical advice"
- Age + research acknowledgment in fine print below button

### Reset Password
- Email field → "Send Reset Link" button
- Success state: envelope icon, confirmation message, 15-minute expiry notice
- Reset tokens: UUID stored in KV with 15-minute TTL, one-time use

---

## Legal & Disclaimers

| Location | Content |
|---|---|
| Signup (checkbox) | "I agree to the Terms of Service and Privacy Policy" — required |
| Signup (checkbox) | "I understand this app is for personal tracking only and is not medical advice" — required |
| Signup fine print | "By signing up you confirm you are 18+ and agree all peptides are used for research purposes only." |
| Today tab footer | "Research use only. Not medical advice." |
| Calculator footer | "For research and personal tracking only. Always verify calculations independently." |
| Library footer | "All peptides listed for research purposes only. Information is educational and not intended as medical advice." |
| Settings footer | Full medical disclaimer + ToS/Privacy links + copyright |
| Every page footer | "© 2026 CW Enterprises. All rights reserved." |

### Terms of Service (page)
- Accessible at `/terms` — static HTML page linked from signup and Settings
- Covers: permitted use (personal tracking, research), prohibited use (commercial redistribution, medical advice reliance), limitation of liability, 18+ requirement

### Privacy Policy (page)
- Accessible at `/privacy` — static HTML page linked from signup and Settings
- Covers: data collected (email, peptide logs), storage (Cloudflare D1, encrypted at rest), no sale to third parties, data deletion on request, GDPR compliance note

---

## File Structure

```
Peptide-mini/
├── index.html                  ← single-file SPA (auth + all tabs)
├── manifest.json               ← PWA manifest
├── service-worker.js           ← offline caching + background sync
├── terms.html                  ← Terms of Service page
├── privacy.html                ← Privacy Policy page
├── worker/
│   └── index.js                ← Cloudflare Worker API
├── wrangler.toml               ← D1 + KV bindings
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-06-02-peptideos-revamp-design.md
```

---

## Preserved from Peptide Mini

All existing data structures and logic are migrated, not replaced:
- 40 built-in peptides list
- Planner (recurring), today/week views, dose logging, vials, draw math, cycle dates, CSV export
- Dark mode support (now with manual toggle and system preference detection)
