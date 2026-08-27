# Punctuality Tracker PWA (Supabase + GitHub Pages)

QR-based arrival / departure tracking for a small team, installable as a PWA
on employee phones. The backend is Supabase (Auth + PostgreSQL + RLS + RPC);
the frontend is a static PWA that deploys to **GitHub Pages** for free.

## What it does

- **Employees** open the app on their phone, tap **Arrive** or **Leave**,
  and scan the QR code posted at the workplace.
- Scans made while offline are queued on the phone (IndexedDB) and
  auto-synced when connectivity returns.
- **Admin dashboard** shows:
  - per-day punctuality summary for each employee — **On time / Late / Absent**
    against a configurable shift start time + grace period;
  - today's KPIs (on time, late, absent, arrivals, departures, offline syncs);
  - a date filter to inspect any past day;
  - an **Export CSV** button for the visible day;
  - the current QR code (regenerate anytime — old codes are revoked server-side),
    and the full attendance history.
- **Security**: employees can never forge records — the RPC function validates
  the signed-in user, an active profile, a valid QR code, and duplicate scans.

## Changes made in this version (vs the original upload)

- **Relative asset paths** (`./...`) so the PWA works on GitHub Pages under a
  `<user>.github.io/<repo>/` subpath (the original used absolute `/` paths
  that break on Pages).
- **iOS QR scanning** — the original only used the `BarcodeDetector` API,
  which does not exist in iOS Safari. Added a **jsQR fallback** (canvas-based
  decoding) so iPhones can scan too.
- **Punctuality engine** — new admin panel sections: daily per-employee
  summary, on-time/late/absent KPI cards, date filter, roster table.
- **CSV export** of the daily summary.
- **Shift start + grace period** config in `public/config.js`.
- **Optional signup allowlist** in `public/config.js` (`allowedEmails`) so only
  your team can create accounts.

## Project layout

```
schema.sql                  # THE database script — run once in Supabase SQL Editor
public/                     # static PWA (deploy this to GitHub Pages)
  index.html  app.js  styles.css  config.js  sw.js  manifest.webmanifest  offline.html  icons/
supabase/migrations/0001_init.sql   # same schema, kept for reference
SETUP.md                    # step-by-step installation manual
```

## Quick start

Full, numbered instructions are in **`SETUP.md`**. The short version:

1. Create a free project at supabase.com → run `schema.sql` in the SQL Editor.
2. Enable Email auth (Dashboard → Authentication → Providers → Email).
3. Copy your Project URL + anon key into `public/config.js`.
4. Push `public/` to a GitHub repo → enable Pages (deploy from branch, root).
   Note: the whole repo can be pushed; Pages publishes the repo root.
5. Open the site, create your account, promote it to admin with one SQL line.
6. Generate the QR, print/display it, and have your employees install the PWA.
