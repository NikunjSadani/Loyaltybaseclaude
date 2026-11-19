# P1 · 1.2 + 1.8 — Sessions & tenant binding (design)

> Status: **APPROVED by user 2026-06-15** (idle 365d; revoke on phone change; subdomain picks tenant
> at login then bound to the session; build as one change). Implementation staged below.

## Confirmed requirements
- **Low-friction "stay logged in":** a device stays logged in **indefinitely** as long as it's used at
  least once every **365 days** (sliding idle window). 365 days of no use → that device re-logs in.
- **Phone-number change → forced logout:** changing a user's phone revokes all their sessions.
- **Server-side "log out all devices":** revoke every session for a user at once.
- **Tenant by subdomain at login, then bound (1.8):** each tenant has its own subdomain, and an
  outlet/phone can exist under multiple tenants (separate `User` rows per `clientId`). The subdomain
  picks **which tenant's account** at login; from then on the tenant is read from the **session**, not
  a re-readable header.

## Why a session store (not stateless JWT)
Revocation, idle-expiry, logout-all, and phone-change-logout are impossible with a stateless JWT —
there's no server record to expire or revoke. So `UserSession` (currently in the schema but **never
written**) becomes the source of truth for "is this login still valid + which tenant."

## The proxy constraint (load-bearing)
`src/proxy.ts` runs in the **Edge runtime** and verifies the JWT with `jose` — **no DB access at the
edge.** Therefore session validation (revoked? idle-expired?) and tenant binding happen in the **app
layer** (`getAuthUser`, Node runtime, has Prisma), not the proxy.
- **Proxy stays as-is:** coarse, fast gate — valid JWT signature + role-route check + inject
  `x-user-id`/`x-user-role` + `x-tenant-slug` (from subdomain). No proxy change needed.
- **App `getAuthUser` upgraded:** the fine gate — look up the session, reject if revoked/expired, bump
  the sliding window, and return `userId` + `role` + **`clientId` (from the session)**.

**Revocation model chosen: per-request session check** (one indexed lookup by token) → **instant**
revocation. Picked over the refresh-token pattern (cheaper but revocation lags by the access-token
lifetime) because phone-change/logout-all should take effect promptly. Caching is a later optimization.

## Data model
`UserSession` already has: `id, userId, token (unique), refreshToken, deviceId, deviceName, ipAddress,
userAgent, expiresAt, revokedAt, createdAt, updatedAt`. **Add:**
- `clientId String` (+ `@@index`) — the tenant, set at login from the subdomain; the 1.8 binding.
- `lastSeenAt DateTime?` — for "last active" display (optional; `expiresAt` is the sliding marker).

`expiresAt` doubles as the idle marker: set to `now + 365d` at login and **bumped to `now + 365d` on
every validated request** (sliding). `now > expiresAt` ⇒ idle-expired.
(The `user_sessions` table is currently **empty** — never written — so adding a NOT-NULL `clientId`
is safe; no existing rows to backfill.)

## Tenant resolution after this change (1.8)
- **Pre-auth** (login screens, send-otp/verify-otp): tenant from the **subdomain** (`x-tenant-slug`) —
  unchanged; necessary because one phone maps to many tenants.
- **Authenticated requests:** tenant from the **session's `clientId`** (bound at login), via a new
  `getAuthContext(req) → { userId, role, clientId, partnerId }`. The old
  `getClientIdFromRequest` header-with-`deoleo`-fallback is replaced on authed paths (and the silent
  `deoleo` fallback — gap #23 — is removed). A mismatch between session `clientId` and the subdomain
  header is rejected (defense-in-depth).

## Staged build (each: executor → gate → independent audit)
- **S1 — schema:** add `UserSession.clientId` (+ index) and `lastSeenAt`. Additive migration on the
  empty table (diff-SQL, dev only, `gifsy_dev` guard — same method as 1.3).
- **S2 — `lib/session.ts`:** pure-ish lifecycle — `createSession`, `validateSession` (revoked/expired
  + sliding bump), `revokeSession`, `revokeAllSessionsForUser`. Deterministic tests.
- **S3 — login wiring:** `verify-otp` creates a session (tenant from the subdomain) and returns its
  token. (Replaces the bare `generateToken`.)
- **S4 — `getAuthUser`/`getAuthContext` upgrade (HIGH blast radius):** validate the session + return
  `clientId` from it. Every authenticated route's auth flows through here → heaviest gate (full suite,
  all route + isolation tests). Tenant binding (1.8) lands here.
- **S5 — lifecycle endpoints + hooks:** logout (revoke current), logout-all (revoke all for user), and
  revoke-on-phone-change in the user-update path.

DEMO_MODE keeps bypassing (no session). Each stage is committed + audited before the next; S4 pauses
for review given its blast radius.

## Build log
- **S1+S2 ✅** committed — `UserSession.clientId`/`lastSeenAt` (additive migration applied to dev
  `gifsy_dev`, empty-table guarded) + `lib/session.ts` (create/validate-slide/revoke/revoke-all).
  Gate: tsc 0, full suite no new reds, +23 tests. **Audit PASS** (note: tiny TOCTOU in validateSession's
  read-then-bump — harden later to `updateMany({where:{token,revokedAt:null}})`; not blocking).
- **S3 ✅** committed — `verify-otp` mints `sid` (crypto.randomUUID), `createSession(token=sid)`, JWT via
  `generateAccessToken` (claims userId/role/clientId/sid; 365d). Gate: tsc 0, no new reds, +19 tests.
  **Audit PASS** (sid↔session linkage exact; demo/failure create no session; 1.9 assertions intact).
- **S4 ✅** committed (96 files) — `getAuthUser` now async + session-validated (token from Bearer/cookie →
  verify → require sid → validateSession → return session userId/clientId + token role/partnerId).
  `await` added at all sync call sites (94 route files). Gate: **tsc 0** (proves await-completeness),
  full suite no new reds (exact 28/105 — zero route regressions), no new lint. DEMO_MODE preserved.
  Audit running. Follow-up: the per-request sliding bump is a write on every authenticated request
  (optimize later — only bump if lastSeenAt is stale).
- **S4b ⏭** — migrate the ~95 `getClientIdFromRequest` routes to use the session `clientId` from
  getAuthUser (finishes 1.8 / removes the silent-`deoleo` fallback, gap #23). Stage by portal.
- **S5 part 1 ✅** committed — `POST /api/auth/logout` (revoke current session + clear token cookie) +
  `POST /api/auth/logout-all` (revoke all of the user's sessions). getAuthUser now returns `sid`. Gate:
  tsc 0, no new reds, +15 tests.
- **S5b ✅** committed — admin edit-phone (`admin/users/[id]` PATCH): phone in schema, per-tenant
  uniqueness 409 guard, `revokeAllSessionsForUser(id)` on actual phone change. Gate: tsc 0, no new reds.
- **S5c ✅** committed — Gifsy `POST /api/admin/force-logout-all` (GIFSY_ADMIN only, CLIENT_ADMIN 403) +
  global `revokeAllSessions()` (no userId/clientId filter) + audit. Gate: tsc 0, no new reds. Combined
  S5 audit running.

**1.2 + 1.8 core is functionally complete** (S1–S5). **S5 combined audit PASS-WITH-NOTES** — no priv-esc,
no cross-user revoke, no escalation to the global logout; phone-change revokes the edited user. Note
(deferred): `force-logout-all` writes its audit AFTER the revoke, so a transient DB error there leaves a
mass-revoke unlogged (500 surfaces) — harden later (audit-before-respond / durable log).

- **S4b ✅** committed + audited — **single enforcement point** (better than the 95-route migration):
  `getAuthUser` rejects when a non-GIFSY session's tenant ≠ the subdomain (`x-tenant-slug`) it's on —
  closes the cross-tenant header-swap (gaps #20/#23) in one auditable place. **GIFSY_ADMIN is exempt**
  (platform operator works cross-tenant via each tenant's subdomain — user-confirmed assumption). Routes
  keep using `getClientIdFromRequest`, which is now trustworthy because getAuthUser guarantees
  header==session for non-Gifsy. (Full route→authUser.clientId migration is now optional defense-in-depth,
  not required.) Multi-tenant outlets unaffected (each subdomain = a separate single-tenant login).
  **S4b audit PASS-WITH-NOTES** — header-swap CLOSED; role-exemption anchored to the verified JWT (not
  spoofable); no legitimate flow broken (Gifsy cross-tenant ✓, multi-tenant outlets ✓, no internal
  cross-tenant callers). ⚠️ **Production note:** DEMO_MODE trusts the `x-user-role` header by design —
  **never enable DEMO_MODE in production** (add to the prod hardening checklist).
- **1.6 ⏭** — RBAC `can()` gate + tenant-configurable role→permission map on the 1.5 catalog (last P1 task).

## ✅ 1.2 + 1.8 COMPLETE (S1–S5 + S4b, all gated + independently audited)
Delivered: persisted sessions; 365-day sliding idle; logout / logout-all-devices; Gifsy platform-wide
force-logout (rollout kill switch); admin edit-phone → auto-logout; tenant chosen by subdomain at login
then bound to the session; `getAuthUser` validates the session (revocable) AND enforces
subdomain==session-tenant for non-Gifsy. Closes gap #20 (token↔tenant binding) and the #23 header-swap.
Deferred follow-ups: phone-change revoke for sales(P2 bulk upload)/outlets(P3 re-KYC); per-request
sliding-bump write optimization; force-logout-all audit-durability ordering; DEMO_MODE prod-hardening doc.

### Phone-change → logout: attach points (user decision 2026-06-15)
The revoke-on-phone-change rule attaches wherever a phone is actually mutated:
- **Admin** — edit-phone option on the admin user form → **S5b (now)**.
- **Sales team** — phone edited via the **bulk sales-hierarchy upload** → wire the revoke into that
  upload path in **P2** (2.1/2.2). TODO marker for P2.
- **Outlets/partners** — phone changed via the **re-KYC route** → wire the revoke into re-KYC in **P3**
  (3.x). TODO marker for P3.
The mechanism (`revokeAllSessionsForUser`) is ready; P2/P3 just call it when they implement phone edits.

### 2026-11-19 — concurrent-refresh race fix (branch `fix/auth-refresh-race`, NOT yet on staging/prod)
> This file is the closest in-repo session design doc; the rolling-session epic itself (60m access
> token, 30d sliding window, proxy page-nav silent refresh, lenient reuse detection) is recorded in
> the auth-rolling-session memory. This note covers only the race fix.

- **Symptom (prod, 2026-11-19 10:38:23 UTC):** one cold page load after the 60m access token expired
  fired ~10 parallel `POST /v1/auth/refresh` (proxy, UA `node`) with the SAME refresh token: 7×200,
  3×401 inside ~20 ms. Any proxy hit that got the 401 redirected to `/auth/login?expired=1`, so a user
  with a valid session could be logged out.
- **Root cause:** `refreshToken` claimed the predecessor (atomic `updateMany … revokedAt:null`) and
  INSERTED the successor as two separate autocommitted statements, with awaited gate reads in between
  (staff grant / partner-deactivated / vendor). A concurrent loser whose claim lost during that window
  looked for the live successor BEFORE it existed → "no live successor, in grace" → 401. (Not a grace
  window or chain problem: the 5s grace only classified the loser, it never waited for the winner.)
  Reproduced in `api/src/auth/auth.service.refresh-race.spec.ts` (row-lock fake DB): 9/10 → 401 before.
- **Backend fix:** gates now run first (read-only, outside any lock; a gate failure still consumes the
  predecessor and re-throws). Then claim + successor INSERT run in ONE interactive transaction
  (`generateTokens(…, { db: tx })`). The claim's row lock is held until the successor commits, so a
  concurrent refresh of the same token blocks, sees `revokedAt` set (count 0) and then finds the
  committed successor → every caller gets the SAME successor pair. A tx failure rolls the claim back
  (predecessor stays live, retryable). Unchanged: unknown/expired/logged-out → 401; logout-all stamp
  checks (before + post-mint re-read); reuse of an old rotated token past grace with no live successor
  → lineage kill + `SECURITY_EVENT`; assumed-tenant scope + staff grant check.
- **Proxy fix (`platform/src/proxy.ts`):** a failed refresh on a NON-document request (RSC payload,
  router/browser prefetch, server action, sub-resource by `Sec-Fetch-Dest`) returns `401 no-store`
  instead of redirecting (an RSC nav falls back to a document nav; prefetches are dropped). A document
  navigation retries the refresh ONCE after 200 ms before redirecting to `/auth/login?expired=1`.
  Concurrent proxy hits for the same refresh cookie share ONE in-flight backend refresh per instance
  (map keyed by SHA-256 of the token, entry dropped on settle; token never logged). Cookies unchanged
  (host-only, lax, same max-ages); `/api/*` still 401s without a server refresh (SessionExpiryGuard).

#### 2026-11-19 — audit fix round (same branch, owner-approved platform-wide)
- **S1 — handoff only in grace (REVERSES the 2026-08-14 "lenient" decision):** a revoked refresh token
  is handed its live successor ONLY if it was revoked ≤5s ago (`ROTATION_GRACE_MS`) or this request's
  own claim lost to a concurrent sibling. Outside grace any revoked token = reuse → stamp, revoke all,
  `SECURITY_EVENT`. **Trade-off:** a client whose refresh RESPONSE was lost still holds the old token;
  its next refresh after 5s is indistinguishable from theft → that user is logged out everywhere.
- **S2:** the refresh claim+mint tx first takes `SELECT … FROM "users" … FOR SHARE` and re-checks
  `sessionsInvalidBefore`. Stamp+sweep inside ONE tx (admin-outlets deactivation, KYC phone change) is
  now safe in both lock orders (stamp first → refresh waits then refuses; refresh first → stamper waits,
  its sweep sees the successor). Lock order user → session everywhere (no deadlock).
- **S3:** a gate error consumes the predecessor only for 401/403; transient errors leave it live.
- **S4:** exit-tenant revokes the WHOLE assumed lineage by walking `rotatedFromId` hop by hop (complete
  even against an in-flight refresh, because claim+mint hold the predecessor's row lock).
- **S5:** no migration — `user_sessions_rotatedFromId_idx` already exists (migration 20260812120000).
- **B1:** the proxy marks the forwarded request `x-session-refreshed: 1` (stripped from client input);
  `refreshSession` then reuses the proxy-rotated pair instead of rotating again.
- **B2:** moot under S1 — the handed-back access token was minted in the same tx as the revoke (≤5s old).
- **B3:** `refreshTokensViaBackend` returns `ok | dead | transient`; the proxy retries a document refresh
  only on `transient`; non-document `dead` → 401, `transient` → 503. `refreshSession` returns
  `transient:true` and `SessionExpiryGuard` does not bounce to login on it. Per-attempt timeout 12s → 4s
  so a retried, already-committed refresh still lands inside the 5s grace.
- **B4:** no `Sec-Fetch-Dest` → still a document, but static-asset paths (by extension) skip the retry.
  `public/guides/*` stays behind auth (admin screenshots), so no matcher change.
- **B5:** `api/test/auth-refresh-race.e2e-spec.ts` (WP7 disposable-Postgres harness). Server-mode
  (real two-connection) scenarios need `WRE_PG_ADMIN_URL` + a local Postgres — NOT run yet.

#### 2026-11-19 — final round (slow-path false logouts)
Rule: the server NEVER commits a rotation after the client gave up. Timing budget (api `auth.service.ts`
header comment ↔ platform `auth-refresh.ts`, pinned by invariant tests on both sides):

| Step | Bound |
|---|---|
| client attempt starts | t0 |
| server commit deadline | min(t0 + 4.0s via `x-refresh-deadline`, receipt + 4.0s) — re-checked before the tx and as the last statement before COMMIT; late → rollback + 503 |
| tx connection wait | `maxWait` 1.5s |
| each lock wait | `SET LOCAL lock_timeout = '1s'` (user FOR SHARE, session claim) → 55P03 → rollback + 503 |
| whole tx | `timeout` 4.0s |
| client gives up | t0 + 5.0s (≥ deadline + 1s for commit + transit) |
| document retry | give-up + 200ms (≤ t0 + 5.2s) |
| rotation grace | **6s (was 5s)**, measured from COMMIT (predecessor `revokedAt` re-stamped as the tx's last statement) |

- Cold start / pool wait before the server sees the request only shrink its remaining budget (the deadline
  is client-anchored). Any tx failure → 503 (transient), predecessor stays live, retry works.
- `SessionExpiryGuard`: a thrown refresh-action call = transient (no login bounce); 3 transients in a row →
  one full page reload (the proxy then decides page vs login). A server action whose proxy refresh failed
  now runs unauthenticated with `x-session-refresh-failed: dead|transient`, so `refreshSession` returns a
  typed result with HTTP 200 (no data exposure: no page/layout trusts proxy identity, data stays behind
  `/api/*`).
- `refreshSession` trusts `x-session-refreshed` only if the merged refresh cookie differs from the one the
  browser sent (F5).
- Not changed: no global pg `connectionTimeoutMillis` (shared pool; would turn queueing in background jobs
  into hard failures); no `FOR SHARE NOWAIT` (user-row writers are ms-short; 1s lock_timeout instead).
