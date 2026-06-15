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
