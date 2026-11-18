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
  is consistent with "at least".
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
- **Totals** (over the filtered population; the inactive toggle changes the list, never the totals): users active of
  in scope, average days active, total minutes (at least) and average per active user, installed-app vs browser
  users, phone vs computer users (a user can be in both).
- **Rows:** name, role, mobile, programme, region, days active, visits, minutes (at least), average minutes per
  *tracked* day (pre-ship days excluded), app days, browser days, phone / computer / both, first seen, last seen.
  Sort: minutes (default) / days / last seen / name. "Show inactive users" lists people with no activity in range.
- **Programme / region (what exists):** retailers — `Outlet.programName` / `Outlet.state` of outlets they own (incl.
  outlets of a group they head); sales staff — `SalesUser.region` when set (dormant today), else programme/state of
  outlets **directly** assigned to them; managers without direct assignments, admins, Gifsy staff and vendors have
  none, so a programme or region filter leaves them out. The page says so.
- **Excel:** export kind `usage-report` (light → streams) writes every filtered row; 0 rows → 404 "0 users matched
  these filters." (neutral note on the page); one `AuditLog` (EXPORT / USAGE_REPORT) before any byte, because mobile
  numbers leave the system — same pattern as the installed-users export.
- **Page note:** the duration rule, "at least", and "Tracking started on <date>" — the first IST day with tracked
  activity for this tenant (read from the data, so it is the real ship date per environment).

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

Runtime on staging (real login per role, an installed PWA on a phone vs a desktop browser, Excel download) — to do
when the release is on staging.
