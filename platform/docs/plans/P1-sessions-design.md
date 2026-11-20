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
- ⚠️ SUPERSEDED 2026-11-20 (see the dual-audit round below: no unauthenticated server-action path; guard uses
  `/auth/session-refresh`). Was: `SessionExpiryGuard`: a thrown refresh-action call = transient (no login bounce); 3 transients in a row →
  one full page reload (the proxy then decides page vs login). A server action whose proxy refresh failed
  now runs unauthenticated with `x-session-refresh-failed: dead|transient`, so `refreshSession` returns a
  typed result with HTTP 200 (no data exposure: no page/layout trusts proxy identity, data stays behind
  `/api/*`).
- `refreshSession` trusts `x-session-refreshed` only if the merged refresh cookie differs from the one the
  browser sent (F5).
- Not changed: no global pg `connectionTimeoutMillis` (shared pool; would turn queueing in background jobs
  into hard failures); no `FOR SHARE NOWAIT` (user-row writers are ms-short; 1s lock_timeout instead).

#### 2026-11-20 — dual-audit round (security + logout risks) and owner decision H4
**Security**
- **S1/M3:** the F3 "server action runs unauthenticated after a failed refresh" path is REMOVED (a `GET` with
  a `Next-Action` header could render a page tree unauthenticated). A failed refresh on any non-document
  request (incl. server actions, GET or POST) now answers 401 (dead) / 503 (transient). The guard no longer
  calls a server action: it POSTs to **`/auth/session-refresh`** (route handler, outside `/api` because
  `beforeFiles` rewrites all `/api/*` to the backend; public edge path authenticated by the refresh cookie;
  POST-only, requires `x-session-refresh: 1`, refuses cross-site `Sec-Fetch-Site`) → 200 / 401 / 503.
- **S2/S3:** the client sends a RELATIVE `x-refresh-budget-ms` (clamped to [500 ms, 4 s] from receipt — no
  clock comparison) plus the absolute `x-refresh-deadline`, now only a SHORTEN-only cap (never below
  receipt + 500 ms) that covers time lost before receipt (cold start). A past/garbage deadline can no longer
  force an instant 503 (no free liveness probe). Headers logged at debug on receipt (L1).

**Logout-risk fixes**
- **H1:** nothing runs after the rotation commits — the post-mint stamp re-read on the shared pool is gone
  (redundant: the in-tx `FOR SHARE` check orders every stamper). A committed rotation always reaches the client.
- **H2:** grace is judged against the request's RECEIPT time, not "now" after a slow DB read.
- **H3/M1/M2/L3:** `SessionExpiryGuard`: a transient refresh is handled ONCE per refresh outcome (not per
  waiting caller), never logs out, shows a `role=status` "Reconnecting…" banner with "Retry now", retries in
  the background with backoff (2/4/8/16/30 s), waits for the `online` event when offline, and after recovery
  reloads ONCE (≤ 1 per 10 min) [⚠️ SUPERSEDED: no automatic reload any more — see next section] — never if the user typed on the page (banner instead). Any successful
  `/api` response clears it. A background retry that finds the session dead → login.
- **M4:** refreshes are serialised across tabs (Web Lock `gifsy-session-refresh`); a tab that waited skips
  its exchange if another tab refreshed < 5 s ago (shared cookie jar).
- **L2:** only 401/403 from the refresh endpoint are "dead"; any other 4xx (mid-deploy 400/404) is transient.
- **L4:** nothing cheap to add server-side. **L5 residual:** if the connection drops AFTER commit, the client
  holds the old token; its retry within 6 s gets the successor (grace), and since H4 a later replay gets it
  while unused (< 60 min); only a replay after the successor was used is treated as theft.

**H4 — owner decision 2026-11-20 (middle option)** — ⚠️ SUPERSEDED by the next section (renew-forward, device binding, one handback, no 60-min cap)
- A revoked refresh token replayed OUTSIDE the 6 s grace is handed back its successor's STORED pair (no new
  rotation, no chain fork) **only while that successor has never been used**: `user_sessions.firstUsedAt IS
  NULL` (set ONCE, awaited, by the JWT guard on the first request authenticated with the successor's access
  token — `updateMany … WHERE firstUsedAt IS NULL`, one write per session lifetime), `revokedAt IS NULL`
  (never refreshed itself), still live, and created < 60 min ago (= access-token lifetime, so the stored
  access token is still valid). Each such handoff writes an info audit row (`entityType AUTH_EVENT`,
  `metadata.event REFRESH_HANDOFF_UNUSED_SUCCESSOR`) — not a SECURITY_EVENT. Once used: STRICT (revoke all +
  stamp + SECURITY_EVENT). Migration `20261120130000_user_session_first_used_at` (additive, nullable, idempotent).
- **Residual risk (owner-accepted):** a thief holding a stolen, already-rotated token can claim the session
  in that ≤ 60-min window IF the legitimate client has not used the successor yet (it lost the response or
  is offline). The theft is then detected on the legitimate client's next replay of the old token (successor
  now USED → strict kill, attacker's session revoked too). A failed first-use write (logged, request still
  served) keeps the lenient window open for that session until its 60-min bound. Gates (deactivated partner,
  suspended vendor, revoked staff grant) are not re-run on a handoff; each of those flows stamps + sweeps the
  user, which excludes the successor (`revokedAt` / `sessionsInvalidBefore`).

#### 2026-11-20 — logout-risk round (C1–M4) + security re-audit (S-H1, S-L2, S-L6) — partly SUPERSEDED by the final round below
> Supersedes the H4 "stored pair, < 60 min" rule and the post-recovery auto-reload above.

**Owner requirement:** "users very likely shift to another app; this must NOT make them log in."

**Never-used-successor handback (H4 → C1 + S-H1), how it works now.** A rotated refresh token replayed
OUTSIDE the 6 s grace (typically: the response that carried its successor was lost on an app switch) walks the
lineage forward (`rotatedFromId`, ≤ 50 hops) to the live tip and:
1. **Strict kill** (revoke all + stamp + `SECURITY_EVENT refresh_token_reuse`, with a `reason`) if ANY link was
   USED — `firstUsedAt` set by (a) the JWT guard on the first request authenticated with that session's
   access token (sid-bound tokens only, set once, awaited, per-instance memo; NOT for server calls flagged
   `x-gifsy-no-first-use`, which the Next server actions send when they use a token the proxy minted in the
   same request), or (b) the session's own holder refreshing it (the normal claim now sets it).
2. **Device binding (S-H1a):** every refresh-minted session stores `createdFingerprint` = SHA-256 of the
   browser User-Agent + `sec-ch-ua-platform` + `sec-ch-ua-mobile` (forwarded by the proxy / route handler as
   `x-client-*`; the API's own UA would be Node's). A handback requires the replaying request's fingerprint to
   equal the FIRST successor's creator fingerprint; mismatch or missing → strict kill (`device_mismatch`).
3. **At most one handback per step (S-H1b):** the renewal claims the tip CONDITIONALLY (`revokedAt`,
   `firstUsedAt`, `handedBackAt` all NULL) and stamps `handedBackAt`. A later replay of the same old token →
   strict kill (`second_handback`); only a concurrent replay of the SAME resume (within 6 s of the handback)
   converges on the renewed pair.
4. **Renew forward (C1):** otherwise the tip is rotated with the normal rules (gates, in-tx logout-all check,
   deadline) → the client gets a FRESH pair; single lineage; no age cap — bounded only by the tip's 30-day
   sliding session (an expired tip → plain 401, no alarm).
5. **Audit (S-H1c):** each handback writes `AUTH_EVENT` / `REFRESH_HANDOFF_UNUSED_SUCCESSOR` with its own
   AuditAction `REFRESH_HANDOFF`; ≥ 2 handbacks for one user within 24 h → `SECURITY_EVENT
   repeated_unused_successor_handoff`. The Daily Ops Digest has a Gifsy-wide "Sign-in security" line: reuse
   kills, users with repeated handbacks, failed first-use marks (S-L2: a failed mark is logged as an error and
   written as `AUTH_EVENT first_use_mark_failed`).

**S-H1(d) — residual risk, precisely (for the owner).** What a thief can still do:
- With the victim's refresh cookie AND the victim's exact User-Agent + client-hint headers (the fingerprint is
  a header hash, not a device secret — it can be copied by anyone who sees the victim's request headers,
  e.g. the same malware/proxy that stole the cookie): if the cookie is an OLD (rotated) token whose successor
  the victim has NOT used yet (victim lost the response / offline), the thief can take over that lineage ONCE
  (one handback per step). The victim's next use of the old token then hits `second_handback` → strict kill
  (both lose the session, `SECURITY_EVENT`). The victim's next use of a token the thief already used → strict
  kill. So the thief gets at most one session until the victim returns, and the return is detected.
- With the victim's CURRENT (live, not yet rotated) refresh cookie: unchanged from classic rotation — whoever
  refreshes first wins; the other side's next refresh is a replay → if the winner already used the new session
  (or is on another device) → strict kill + alarm; the device binding stops the "thief rotates first, victim
  is handed the thief's session, both share it forever" pattern (S-H1).
- Without the victim's headers: any post-grace replay from another device is a strict kill.
- Not covered by design: a thief who controls the victim's device/browser (can read everything anyway).
- Legit edge that still logs out: the same device losing the response of the HANDBACK itself and replaying
  the old token again > 6 s later (`second_handback`), or a browser update between the rotation and the
  replay (UA changed → `device_mismatch`). Both are rare; both are owner-visible in the digest.

**Logout-risk fixes (frontend / proxy)**
- **C2:** a page load whose refresh fails TRANSIENTLY (after the one 200 ms retry) gets a self-contained
  "Reconnecting…" page (503, no-store) that reloads the SAME URL with backoff (2/4/8/16/30 s, then 60 s;
  Retry button; on `online` and tab-visible). Only a DEAD refresh goes to `/auth/login?expired=1` (the login
  page's skipped session check on `expired=1` is therefore only ever reached with a dead session).
- **H1:** wrong/expired redemption OTP → 400 (was 401). Every session 401 carries `x-auth-failure: session`
  (proxy + API `JwtAuthGuard`); `SessionExpiryGuard` ignores 401s without it. Login OTP 401s stay under
  `/api/auth/*` (always ignored by the guard). [Correction, final round: KYC consent and scheme OTPs were 401 too — now 400.]
- **H2/H3:** no automatic reload after recovery (unsaved input, camera-captured POSM photos); the banner
  clears and a `session:restored` window event lets a page opt in to re-fetch.
- **H4:** the guard's refresh exchange has a 7 s timeout (a stuck request no longer holds the Web Lock).
- **M4 / Low:** "Retry now" in every banner state (incl. offline); retries on `online`, tab-visible and focus;
  after the fast backoff it keeps retrying every 60 s. Copy: "Reconnecting…" only for 503/network/timeout;
  "Something went wrong" for other statuses; no "unsaved changes kept" claim. Banner moved to the TOP (safe-area)
  so it never covers bottom navigation or a submit bar.

**Deploy order (M3) — verified in the workflows:** both `deploy-staging.yml` and `deploy.yml` run
`prisma migrate deploy` as a Cloud Run job with `--execute-now --wait` BEFORE `gcloud run deploy` of the API,
and the frontend deploys after the API (prod: `needs: deploy-api`; staging: `needs: [test, deploy-api-staging]`).
Belt-and-braces: the JWT guard now selects only `id` + `expiresAt`, so the per-request hot path never depends
on the new columns; a first-use mark before the migration would fail loudly and the request still succeeds.

**Migrations (S-L6):** `20261120130000_user_session_first_used_at` (edited in place — never applied anywhere):
adds `firstUsedAt` and, only in the run that creates it (DO-block guard), backfills `firstUsedAt = createdAt`
for LIVE sessions (~1.2k rows on prod, one small UPDATE) so pre-deploy sessions never qualify for a handback;
adds `handedBackAt`, `createdFingerprint`. `20261120130100_audit_action_refresh_handoff`: AuditAction
`REFRESH_HANDOFF` (own migration — a new enum value can't be used in the transaction that adds it).

**S-M1 — follow-up PROPOSAL (not implemented; owner decision needed): stop storing usable tokens in clear.**
Today `user_sessions.token` / `refreshToken` hold the live access/refresh tokens in plaintext, so a DB read
(backup, replica, SQL access) yields working sessions. Proposal:
1. Store `refreshTokenHash = SHA-256(refreshToken)` (unique index) instead of the token; look up by hash.
2. Store no access token at all (the JWT is self-contained; the `sid` claim already binds it to the row).
3. Consequence for the grace/handback design: the in-grace convergence currently RETURNS THE STORED pair of
   the successor; without stored tokens it must instead MINT a fresh access token for the successor's
   session and hand back a refresh token — which needs either (a) a second, deterministic refresh secret
   per session (e.g. HMAC(serverKey, sessionId‖version)) that can be recomputed, or (b) converging by
   rotating the successor forward (like C1's renew-forward) for in-grace siblings too.
4. Rollout: dual-write hash + plaintext for one release, backfill hashes, switch reads, then null the
   plaintext columns. Migration + code change on the hottest auth path → own build + dual audit.

#### 2026-11-20 — final round (lane A security + lane B logout) — CURRENT DESIGN
> Supersedes in the section above: "second handback → strict kill", "device mismatch → strict kill", the
> 2-per-24 h alarm, the version-sensitive fingerprint, "KYC / scheme OTPs were already 400" (they were 401;
> now 400), and the 7 s guard timeout.

**Owner rule:** app switching must NEVER force a login; detection of real theft must stay.

**Post-grace replay of a rotated token — decision order** (`AuthService.handbackUnusedSuccessor`):
1. Within 6 s of a handback in this lineage (the replayed token's own `handedBackAt` or a later link's) →
   converge on the live tip's stored pair; audited `AUTH_EVENT REFRESH_HANDOFF_REPEAT` (M-1, LOW2). Checked
   BEFORE the "used" check, like the holder in-grace path.
2. (L1, last round) A replayed token that was itself handed back earlier is NOT special-cased any more: same
   device + still-unused tip → a normal (capped) handback; a different device → the mismatch path (7).
3. No live tip → strict reuse kill (all sessions, stamp, `SECURITY_EVENT refresh_token_reuse`).
4. Any link USED → strict reuse kill (thief detection).
5. Tip naturally expired → plain 401.
6. Fingerprint UNKNOWN — presented (untrusted call, older frontend, non-browser UA) or stored (no `v3:` prefix,
   e.g. a row written before this scheme) → plain 401 for this device, no alarm, no kill; an INFO
   `AUTH_EVENT handback_refused_device_unknown` row + counter, shown in the Daily Ops Digest (L3).
7. Fingerprint MISMATCH → 401 + THIS lineage ends + `SECURITY_EVENT … device_mismatch` — no all-device kill.
8. ≥ 5 handbacks in the WHOLE lineage within 24 h — ancestors of the replayed token included, so replaying a newer
   token can't reset the count (L2) → 401 + this lineage ends + `SECURITY_EVENT … handback_cap_reached`.
9. Otherwise renew forward from the live tip (conditional claim: unused, never handed back). This may repeat
   when the handback REPLY itself was lost (H-A a) — as long as the newest tip is unused and the device matches.
- "Ends this lineage" = revoke the replayed token's descendants only (the device that presented it must sign in
  again; whoever else holds that lineage — e.g. a thief who rotated first — is cut off). The user's OTHER devices
  have their own lineages and stay signed in.
- After a COMMITTED handback nothing else runs before the response: audit row, 24 h count and the repeat alarm
  (`SECURITY_EVENT repeated_unused_successor_handoff` at ≥ 5 per user per 24 h) run in the background; a failed
  write is logged as an error, counted (`handbackAuditFailures`) and — best effort, it may fail for the same reason —
  written as `AUTH_EVENT handback_audit_failed`, which the Daily Ops Digest counts (L4). Note: Cloud Run may
  throttle the CPU once a response is sent (unless CPU is always allocated), so these background writes can land
  seconds later — until the instance handles its next request.

**Device fingerprint (M-2, M1, L5 — scheme `v3`):** `v3:` + SHA-256 of browser FAMILY + OS GROUP, no version
numbers and no mobile flag. OS groups: android|linux and ios|macos are one group each, so a browser/OS update or the
"Request desktop site" toggle (Android Chrome → X11 Linux without "Mobile"; iPhone/iPad Safari → Macintosh) does not
change it. Only a REAL browser User-Agent (`Mozilla/5.0 (…`) yields a fingerprint. It is built ONLY for a trusted
call (valid internal secret) from the browser's `x-client-*` headers; every other case — untrusted / drifted secret,
older frontend without `x-client-user-agent`, a direct caller, a non-browser UA — is UNKNOWN (never a mismatch).

**Server-to-server secret (security MED):** `x-gifsy-no-first-use` and `x-client-*` are honoured by the API only
with `x-internal-proxy-secret` = env `INTERNAL_PROXY_SECRET` (constant-time compare). Fail-safe while unset:
first use is always marked; every refresh fingerprint is UNKNOWN. The proxy strips all of these headers (and the
secret header) from client input. A call carrying `x-client-*` without a valid secret is logged as a WARN (secret
drift between the services); in production a missing / short secret is an ERROR at API startup and a Daily Ops
Digest line.
- ⚠️ While the secret is missing or drifted, no lost-response device can be handed back (UNKNOWN → plain 401 →
  that device signs in again) — but nobody is ever killed or alarmed for it.

**Required env / secret wiring — DONE in this branch by `9a85c8de` (deploy workflows bind
`INTERNAL_PROXY_SECRET(_STAGING)` on the API AND frontend services, preflight-checked). Remaining owner steps:
create the two secrets and grant access (1 and 4 below).**
1. Create Secret Manager secrets (random, ≥ 32 chars, generated without a trailing newline, e.g.
   `openssl rand -hex 32 | tr -d '\n'`): `INTERNAL_PROXY_SECRET_STAGING` and `INTERNAL_PROXY_SECRET` (prod).
2. `deploy-staging.yml`: add `INTERNAL_PROXY_SECRET=INTERNAL_PROXY_SECRET_STAGING:latest` to `--set-secrets`
   of BOTH `gcloud run deploy gifsy-api-staging` AND `gcloud run deploy gifsy-frontend-staging`; add it to the
   staging secrets preflight list.
3. `deploy.yml` (prod): same — `INTERNAL_PROXY_SECRET=INTERNAL_PROXY_SECRET:latest` on BOTH `gifsy-api` and
   `gifsy-frontend` deploys; add to the prod preflight list.
4. Grant the API and frontend runtime service accounts `roles/secretmanager.secretAccessor` on the new secrets
   (same as the other `--set-secrets` entries). Local dev: optional (unset = fail-safe).
- Not needed by the migrate / worker jobs.

**Logout-path fixes (lane B):**
- Guard exchange timeout 10 s (covers browser → route → API; Next→API gives up at 5 s; the API never commits
  later than 4 s after receipt). `AbortSignal.timeout` falls back to `AbortController` + timer (older Safari, M-3).
- While the session is alive-but-unreachable, callers get a typed transient error (503, `transient: true`,
  `x-session-transient: 1`, "Connection problem — please retry.") instead of the raw 401 — downloads, Voucher
  Dispersal and Sales Import show that text, never "your session has expired".
- Reconnecting page: "Sign in again" link appears after ~2 min (user's choice); auto-retry stops after 30 min
  (Retry still works).
- Wrong / expired OTPs are 400 everywhere outside `/api/auth/*`: redemption, scheme enrollment, KYC consent.

**Residual risks (precise):**
- The fingerprint is a COARSE device class, not a secret: a thief who has the victim's (old) refresh cookie AND
  uses the same browser family on the same OS GROUP passes the device check — and since L5 the groups are wider:
  Chrome on a Linux desktop matches Chrome on an Android phone; Safari on a Mac matches Safari on an iPhone. Such a
  thief can take over a lineage only while its newest session is UNUSED (the victim lost the response or is
  offline). The victim's next request with the old token then either converges (within 6 s) or finds the tip
  used by the thief → strict kill of every session + alarm. At most 5 handbacks per lineage per day; ≥ 5 per
  user per day alarms.
- A thief with a different device class gets nothing (401) and the attempt ends that lineage — if the victim
  was using that lineage, the victim's device must sign in again (a thief can cause that one-device logout,
  never an all-device one).
- A thief who rotates FIRST from a stolen LIVE token (classic race): the victim's next refresh is a replay;
  same device class + thief hasn't used it yet → the victim is renewed forward and the thief's session is
  revoked by that rotation; thief used it → strict kill + alarm; different device class → lineage ends (thief
  cut off) + alarm, victim signs in again on that device.
- While `INTERNAL_PROXY_SECRET` is missing / drifted on either service, every fingerprint is UNKNOWN: no handbacks
  at all (a lost-response device signs in again), but no false alarms and no kills; WARN / startup ERROR / digest.
- LOW4 (pre-existing, from the re-audit): acknowledged, no change in this branch.
