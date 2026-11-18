# Usage Report — design note

**Status:** built on `feat/usage-report` (worktree `.claude/worktrees/usage-report`), not merged, not deployed.
**Scope:** ⚠️ PLATFORM-WIDE — owner-approved 2026-11-18, ships with the combined release (all tenants incl. Deoleo).

## What the owner asked for

"A user-based report… who is using the app or browser. The medium should also be captured and the duration should
also be captured. Don't need a 'still here' signal." Approved rules: duration = time from the first to the last real
action in a visit; a new visit after 30 minutes idle; it is a minimum ("at least X minutes"); counts from the day it
ships (no backfill).

## Tracking (API)

- **Where:** `JwtStrategy.validate` (every authenticated request) → `ActivityTrackingService.markActive(userId,
  clientId, {medium, device})` — fire-and-forget, returns synchronously, never throws, never awaited
  (`api/src/activity/activity-tracking.service.ts`).
- **Row shape:** the existing `user_activity_day` (one row per user per IST day) gains six additive columns
  (migration `20261118190000_user_activity_usage`): `visits`, `activeSeconds`, `appUsed`, `browserUsed`, `phoneUsed`,
  `computerUsed`. `firstSeenAt` / `lastSeenAt` already existed. `visits = 0` marks a day recorded before this shipped
  (it still counts as an active day; it has no duration or medium).
- **One atomic upsert** (`buildActivityUpsertSql`), so any number of Cloud Run instances stay correct — all maths
  happens inside the row-locked `ON CONFLICT … DO UPDATE` from the row's stored values:
  - gap = now − stored `lastSeenAt`; 0 < gap < 30 min → `activeSeconds += gap` (same visit);
  - gap ≥ 30 min → `visits += 1`, nothing added for the idle time; first write of a day → `visits = 1`;
  - gap ≤ 0 (a slower instance's older request landing late) → nothing added, `lastSeenAt` keeps the later time;
  - medium/device booleans are OR-ed; timestamps are sent as UTC text and cast, so the DB session time zone
    cannot shift them.
- **Throttle:** at most one write per user per 60 s per instance (in memory, reset at the IST day roll) — except a
  request bringing a medium/device not yet sent today writes at once (so the medium is never hidden by the
  throttle). Consequence: ~1-minute resolution — up to about a minute at the end of a visit can go uncounted, which
  is consistent with "at least". Visit boundaries are likewise accurate to about ±1 minute: the gap is measured from
  the last WRITTEN action (each write carries its real request time), so an idle gap of 29–30 minutes may be
  counted as a new visit (review M6 — documented, not modelled).
- **Hot-path guards (review A-M1):** at most 5 activity writes in flight per instance — beyond that a write is
  DROPPED (never queued; sampled warn log, at most once a minute). A failed write keeps the user's throttle entry
  and backs that user off for 5 minutes (no retry on the next request — a sick DB never gets one write per
  request); sampled warn log. `ActivityTrackingService.stats()` exposes in-flight / dropped / failed counts.
- **Only real actions count (review C1):** a request carrying `X-Background: 1` (strictly `1`) is authenticated as
  usual but `JwtStrategy` does NOT call `markActive` at all — no active day, no visit, no duration, no medium.
  Misuse can only hide the sender's own activity, never inflate anyone's. Sites: see "Background requests" below.
- **Midnight:** each IST day is its own row. A visit spanning midnight is split: day 1 keeps time up to its last
  action before midnight; day 2 starts a new visit at its first action after it (the minutes between those two
  actions are not counted). Nothing is "closed at 23:59:59" — that would invent time.

## Medium (platform → API)

- **App vs browser:** `platform/src/lib/client-medium.ts` patches `window.fetch` once, when
  `components/pwa/ClientMediumHeader.tsx` (mounted in the root layout) is first evaluated — before any page effect
  fires its first request. Every same-origin `/api/*` call gets `X-Client-Medium: app` (display-mode standalone, or
  iOS `navigator.standalone`; same detection as `InstallBeacon`, now shared) or `browser`. Third-party URLs are never
  tagged. The Next proxy (`src/proxy.ts`) copies all request headers (it strips only its own internal ones) onto the
  `/api → /v1` rewrite; the Cloudflare worker forwards all headers. Pinned by `__tests__/proxy.test.ts`.
- **API validation:** the header is untrusted — exactly `app` / `browser` (case/space-insensitive) count; anything
  else (missing, repeated, junk) is `unknown` and records nothing (`api/src/activity/client-medium.ts`).
- **Phone vs computer:** from the User-Agent. Phone = Android / iPhone / iPad / iPod / "Mobi" and other mobile
  markers (tablets count as phones); computer = Windows / Macintosh / X11 / Linux / ChromeOS; else unknown
  (server-to-server calls). Known limit: iPadOS Safari requests the desktop site, so an iPad reports "Macintosh" and
  counts as a computer.
- Server-side calls (e.g. the session refresh server action) carry no medium header → recorded as activity with no
  medium, same as before.
- The shared api client (`lib/api-client.ts`) also sends `X-Client-Medium` explicitly (review A-M3), so api-client
  calls are tagged even if some code captured a `fetch` reference before the global tagger was installed.

## Background (automatic) requests — tagged `X-Background: 1` (review C1)

Owner rule: only REAL actions count. Every automatic request is tagged (`backgroundInit()` for raw fetch,
`api.get(url, { background: true })` for the shared client); the API then skips activity tracking entirely.

| Site | What | Notes |
|---|---|---|
| `lib/notifications/use-notifications.ts` | bell unread-count (mount + every 60 s) | also PAUSES while the tab is hidden; one refresh on becoming visible |
| `components/exports/downloads-nav-badge.tsx` (`fetchExportList(…, { background })`) | Downloads badge count (mount / page change / event / 30 s poll) | all automatic |
| `components/exports/downloads-panel.tsx` | Downloads list auto-refresh timer + tab-return refresh | first load and the Refresh button stay real |
| `app/admin/sales-import/[id]/page.tsx` (`salesImportApi.get(id, { background })`) | import status polling (2 s / 5 s) | the first load is the person opening the page |
| `app/admin/whatsapp-broadcasts/[id]/page.tsx` | live funnel poll (5 s, `silent`) | |
| `app/gifsy/voucher-dispersal/[id]/page.tsx` (`vdApi.getCampaign/rows/process(…, { background })`) | campaign poll + processing nudge | `process` is single-flight: if a real Confirm started it, that real request is the one sent |
| `components/pwa/InstallBeacon.tsx` | installed-app beacon POST | |
| `components/pwa/PushSubscriptionManager.tsx` → `lib/pwa/push.ts` | automatic push re-sync on load / after the automatic permission prompt | the "Enable" tap stays real |

Checked and NOT tagged (they make no network request): the partner dashboard banner carousel (`setInterval` rotates
slides), QR-scanner frame loops (`bank-or-upi-section.tsx`, `SchemeFormRenderer.tsx` — camera frames decoded
locally), OTP / resend countdowns (`sales/kyc/new`, `sales/catalogue`, `SchemeFormRenderer.tsx`),
`lib/platform/tenant-routing-cache.ts` (server-side, no user token). `SessionExpiryGuard`'s silent refresh is a
server action, not an authenticated `/api` call. Any NEW poll/timer must use `backgroundInit()` /
`{ background: true }`.

## Report

- **Page:** `/admin/reports/usage` (listed on `/admin/reports`, Engagement). Page permission `reports:read`
  (inherits `/admin/reports`), same as the Session Report.
- **API:** `GET /v1/reports/usage?from&to&role&program&region&sort&includeInactive&page&pageSize[&format=xlsx]` —
  `@Roles('GIFSY_ADMIN','MIS_USER','CLIENT_ADMIN')` + `reports:read`, exactly the Session Report's gate.
  IST dates, inclusive, default last 30 days, max 366 days. `pageSize` ≤ 200 (page uses 50).
- **Scope:** the caller's JWT `clientId` (CLIENT_ADMIN / MIS → own tenant; Gifsy → the assumed tenant; un-assumed
  Gifsy → their home tenant), users = that tenant's non-deleted users, activity joined by `userId` — identical to the
  Session Report.
- **Builder:** `api/src/reports/usage/usage-report.ts` — 5 reads (users, outlets, sales assignments, ONE grouped SQL
  aggregate per user over the range, tracking start date). Shared by JSON and Excel so they never disagree.
- **Totals** (over the filtered population; the "no activity" toggle changes the list, never the totals): users
  active of in scope, average days active, total minutes (at least) and the average per user WITH TRACKED DAYS
  (users whose only days predate tracking are left out of that average — M1), installed-app vs browser users, phone
  vs computer users (a user can be in both). Totals are dimmed (`aria-busy`) while new filters load (M5).
- **Population (M4):** enabled accounts matching the filters, plus deactivated/suspended accounts that WERE active in
  the range. Deactivated/suspended accounts with no activity are left out and shown as one separate number
  ("N deactivated/suspended not counted").
- **Rows:** name, role, mobile, programme, region, days active, visits, minutes (at least), average minutes per
  *tracked* day (pre-ship days excluded), app days, browser days, phone / computer / both, first seen, last seen.
  Sort: minutes (default) / days / last seen / name. "Show users with no activity in this range" lists enabled
  accounts that did not use it. The table has a screen-reader caption.
- **Performance (M3):** each request builds the report once (5 reads; the per-user aggregate is ONE grouped SQL
  statement in its own transaction with `SET LOCAL statement_timeout = 20 s` — a timeout → a clear 503 "choose a
  shorter range"). Paging re-runs the build (no cross-request cache) — fine at Bajaj scale (~9k users, one grouped
  aggregate); revisit only if it shows up as slow.
- **Missing migration (A-M2):** if the columns are not there, the report answers 503 "The usage report is not
  available yet: its database update has not been applied…" (Postgres 42703 / 42P01 mapped), never a bare 500.
- **Programme / region (what exists):** retailers — `Outlet.programName` / `Outlet.state` of outlets they own (incl.
  outlets of a group they head); sales staff — `SalesUser.region` when set (dormant today), else programme/state of
  outlets **directly** assigned to them; managers without direct assignments, admins, Gifsy staff and vendors have
  none, so a programme or region filter leaves them out. The page says so.
- **Excel:** export kind `usage-report` (light → streams) writes every filtered row, plus an "About" sheet with the
  duration note, the tracking start date, the programme/region rule, the background rule and the filters (M2); 0 rows → 404 "0 users matched
  these filters." (neutral note on the page); one `AuditLog` (EXPORT / USAGE_REPORT) before any byte, because mobile
  numbers leave the system — same pattern as the installed-users export.
- **Page note:** the duration rule, "at least", and "Tracking started on <date>" — the first IST day with tracked
  activity for this tenant (read from the data, so it is the real ship date per environment).

## Runbook — deploy / migration (review A-M2)

- **Order (confirmed):** `.github/workflows/deploy.yml` step "Run DB migrations (production)" and
  `deploy-staging.yml` step "Run DB migrations (staging)" run the migrate Cloud Run job (`prisma migrate deploy`,
  `--wait`) INSIDE the deploy-api job, BEFORE the new API revision is deployed; a failed migration fails the deploy, so
  new code never serves against the old schema. The OLD revision keeps serving safely against the migrated schema
  (additive columns with defaults; its Prisma upsert ignores them).
- **When:** low traffic. `ADD COLUMN … DEFAULT` is metadata-only but needs a brief ACCESS EXCLUSIVE lock on
  `user_activity_day` (written on every authenticated request); `lock_timeout = 5s` makes it fail fast instead of
  queueing requests behind it.
- **If it fails** (e.g. the lock timeout under load): re-run the deploy at a quieter time. If Prisma recorded the
  migration as failed: back up, then (owner-approved, via the in-VPC migrate job)
  `npx prisma migrate resolve --rolled-back 20261118190000_user_activity_usage`, then re-deploy. The SQL is idempotent
  (`IF NOT EXISTS`), so a partial earlier run is safe.
- **If the new API ever runs without the migration:** requests are unaffected; activity writes fail (backed off per
  user, sampled warn `activity write failed … column "visits" does not exist`) and the report shows the clear
  "not available yet" 503. Active-day stamps stop until the migration runs (a gap in the Session Report too), so
  treat that warn as urgent.

## Session Report

Unchanged: it still counts `user_activity_day` rows per month. The throttled writer still creates exactly one row per
user per IST day.

## Tests

- `api/src/activity/client-medium.spec.ts` — header parsing, UA phone/computer, never throws.
- `api/src/activity/activity-tracking.service.spec.ts` — throttle, medium bypass, day roll, never blocks/throws; the
  real SQL on PGlite (real Postgres in a forked child, `api/test/pglite-harness.cjs` +
  `api/src/common/testing/pglite-testkit-spec.ts`): consecutive actions, 30-minute gap, midnight split, late older
  write, interleaved writers, insert race, legacy row, time-zone independence, migration idempotent.
- `api/src/auth/strategies/jwt.strategy.spec.ts` — request context passed; validate resolves when the write hangs or
  throws.
- `api/src/reports/usage/usage-report.spec.ts` — params, totals, filters, sorting, pagination, tenant isolation,
  inactive toggle, 9k-user scale, aggregate SQL on PGlite, service, Excel kind (audit before bytes, 404).
- `api/src/reports/reports.controller.spec.ts`, `api/src/exports/kinds/round-trip.spec.ts`.
- Platform: `lib/__tests__/client-medium.test.ts`, `__tests__/proxy.test.ts`,
  `app/admin/reports/__tests__/usage-report.test.tsx`, `lib/__tests__/route-permissions.test.ts`.

## Not verified yet

Runtime on staging (real login per role, an installed PWA on a phone vs a desktop browser, a tab left open with the
bell polling → no minutes added, Excel download incl. the About sheet) — to do when the release is on staging.
Added tests for the review round: `lib/__tests__/background-requests.test.ts` (bell header + hidden-tab pause, api
client headers, badge / push / sales-import / voucher-dispersal tags), `jwt.strategy.spec.ts` S5d (background → no
markActive), `client-medium.spec.ts` (strict `X-Background`), activity spec (backoff, in-flight cap),
`usage-report.spec.ts` (M1/M4 totals, statement timeout, 42703/57014 → 503, About sheet), page test (M5 dimming,
503 message, caption).
