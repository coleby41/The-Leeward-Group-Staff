# Staff-App

Internal staff portal for The Leeward Group. Plain HTML/CSS/JS — no build step, no bundler, no framework. Deployed on Vercel as a static site, auto-deployed from `main` on this repo. Live at `stafftheleewardgroup.vercel.app`.

Backend is Supabase: Postgres with Row Level Security, Supabase Storage, Supabase Auth, and a handful of Edge Functions.

## Structure

```
Staff-App/
├── index.html              Login page (kept at root — Vercel's default entry point)
├── 404.html                Not-found page
├── vercel.json             Rewrites so old bookmarked URLs (e.g. /venders.html) still work
├── pages/                  Every other HTML page (dashboard, projects, timesheet, vendors, ...)
├── js/                     Page and shared JS, one file per page/module
│   └── dashboard/          JS for the dashboard's individual cards (weather, tasks, calendar, ...)
├── css/
│   └── styles.css          Single shared stylesheet for the whole app
├── sql/                    Supabase SQL migrations and setup scripts, run manually in the SQL Editor
├── assets/
│   └── logos/              Brand assets
├── scripts/
│   └── migrate-staff-to-auth.ts   One-off migration script (not part of the deployed app)
├── supabase/                Supabase Edge Functions (if present in your working copy)
└── ROLLOUT-RUNBOOK.md      Step-by-step guide for shipping a fresh environment
```

## Why the root-level redirects

Before this reorg, every page lived at the repo root (`/venders.html`, `/dashboard.html`, `/time sheet.html`, ...) because Vercel serves a static repo's files at their exact paths with no config. Staff have those URLs bookmarked. `vercel.json` rewrites every old root-level URL to its new `/pages/...` location, so nothing breaks for anyone already signed in or bookmarked.

New links anywhere in the app should point at the new `/pages/...`, `/js/...`, `/css/...`, `/assets/...` paths directly — the rewrites exist for backward compatibility, not as the primary route.

## Naming notes

A few files were renamed for consistency while moving them:

| Old name | New name |
|---|---|
| `venders.html` | `pages/vendors.html` |
| `time sheet.html` | `pages/timesheet.html` |
| `project-to-do.html` | `pages/project-todo.html` |
| `staff-to-do.html` | `pages/staff-todo.html` |
| `dashboard scripts/calender-card.js` | `js/dashboard/calendar-card.js` |
| `SQL FILES/` | `sql/` |

All of these are covered by `vercel.json`, so old links still resolve.

## Working locally

There's no install step — open `index.html` in a browser, or serve the folder with any static file server (`npx serve`, `python3 -m http.server`, etc.). Supabase config lives in `js/supabase-config.js`.

## Database changes

SQL migrations live in `sql/` and are run by hand in the Supabase SQL Editor — there's no migration runner. Newer files generally supersede or patch earlier ones; see each file's header comment for what it does and whether it depends on another script having run first.

## Known issue

`pages/my-tasks.html` (and a few code comments elsewhere) reference a `dashboard-shared.js` file that doesn't exist anywhere in the codebase. This predates this reorg — it wasn't introduced by the folder restructure. Worth a look at some point: either that script was deleted at some point without removing the reference, or it was never actually needed.

## Vendor Portal + Bid Invites

Vendors have their own website (the **Vendor Portal**, a separate repo / Vercel project). This repo holds everything on the staff side plus the backend both sites share:

- **Staff pages:** Vendors › More Actions › *Vendor Applications* (approve / reject new vendors), the vendor page (`pages/vendor.html?id=` — company & account info, contacts with vCard download and merge, projects, tax info), and each project's *Bid Invites* page.
- **SQL:** `sql/supabase-vendor-portal-setup.sql` (tables, permissions, RLS) and `sql/supabase-bid-invites-cron-setup.sql` (daily reminder job).
- **Edge Functions** (`supabase/functions/`): `bid-invites`, `bid-reminders`, `vendor-admin` (staff, JWT checked) and `vendor-auth`, `vendor-apply`, `vendor-api` (called by the Vendor Portal — deploy with `--no-verify-jwt`; they do their own session checks).

Setup, in order:

1. Run `sql/supabase-vendor-portal-setup.sql` in the SQL Editor.
2. Deploy the functions:
   ```bash
   supabase functions deploy bid-invites
   supabase functions deploy bid-reminders
   supabase functions deploy vendor-admin
   supabase functions deploy vendor-auth --no-verify-jwt
   supabase functions deploy vendor-apply --no-verify-jwt
   supabase functions deploy vendor-api --no-verify-jwt
   ```
3. Deploy the Vendor Portal to Vercel, then set the secrets (no trailing slash):
   ```bash
   supabase secrets set VENDOR_PORTAL_URL=https://<vendor portal URL> STAFF_PORTAL_URL=https://<staff portal URL>
   ```
   `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (optionally `BID_FROM_EMAIL`) must already be set, with the sending domain verified in Resend.
4. Run `sql/supabase-bid-invites-cron-setup.sql` (reminders).
5. Give the right workgroups the new permissions in IT Tools › Permissions: `vendors.approve_applications`, `vendors.send_bid_invites`, `projects.manage_bid_invites` (IT and Super Admin have them by default).
