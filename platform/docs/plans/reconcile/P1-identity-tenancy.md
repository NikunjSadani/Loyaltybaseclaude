# Reconcile — Task 1.0 · Identity, tenancy & access (P1) vs spec §01 #1–2

> Plan against the spec, build against the code — where they disagree, the code wins and the spec is corrected.
> Tag legend: **VERIFY** (looks done — prove with a test) · **COMPLETE** (partial/stub/duplicated — finish/consolidate) · **BUILD** (missing).

Audit date: 2026-06-14. Read-only. Sources: `lib/auth.ts`, `lib/tenant.ts`, `lib/platform/*`,
`api/auth/*`, `api/admin/users*`, `prisma/schema.prisma`.

## Per-task tags

| Task | Tag | One-line state |
|---|---|---|
| 1.1 OTP/JWT end-to-end | **COMPLETE** | Works, but OTP sends via the *retired* `notifications.ts` path (not `msg91.ts`); route logic duplicates `auth.ts` helpers with a divergent expiry; uses deprecated `signToken`. |
| 1.2 Sessions + `auth/me` + user CRUD | **COMPLETE** | `auth/me` + list + create + bulk-edit are scoped & solid. **`UserSession` model is never written** (JWT-only); **`[id]` route is not tenant-scoped → cross-tenant hole.** |
| 1.3 DB `Client`/tenant model + backfill | **BUILD** | No `Client`/`Tenant` table exists. Tenants live only in the in-code `CLIENT_REGISTRY` (gap #22). |
| 1.4 Feature flags + branding from DB; admin config UI | **BUILD** | `ClientConfig`/`FeatureFlags`/`isFeatureEnabled` exist as pure code reading the in-code registry; no DB read, no admin UI. Depends on 1.3. |
| 1.5 Permission catalog (#3) | **BUILD** | No `lib/rbac/`. 65 route files do inline role-string checks. |
| 1.6 Configurable admin roles + `can()` (#2) | **BUILD** | Role is a fixed `UserRole` enum; gating is hardcoded `role !== 'GIFSY_ADMIN'`. Depends on 1.5. |
| 1.7 Tenant-isolation guardrail (#23) | **BUILD** | No audit test; the `[id]` hole + the silent `deoleo` fallback are the live risks. |
| 1.8 Token↔tenant binding (#20) | **BUILD** — *human-gate* | clientId is **not** in the JWT; trust comes from the `x-tenant-slug` header + proxy `x-user-*` headers. Needs proxy-owner decision. |
| 1.9 Audit + login log writes | **COMPLETE** | `AuditLog` writes inline in user routes (good). **`LoginLog` is never written** (only *read* by the engagement report — always empty); `lastLoginAt`/`loginCount` never updated; no `lib/audit` helper. |

## Ground-truth facts (with evidence)

**Identity model (`schema.prisma`):**
- `UserRole` is a fixed 11-value enum (`GIFSY_ADMIN`, `CLIENT_ADMIN`, `MIS_USER`, `SALES_HO`, `SALES_STATE_HEAD`, `SALES_ASM`, `SALES_SO`, `SALES_ISR`, `SSS`, `WHOLESALER`, `SUB_STOCKIST`) — schema.prisma:13. This *is* gap #2 (RBAC hardcoded).
- `User.clientId String` with `@@unique([clientId, phone])`, `@@unique([clientId, email])`, `@@index([clientId])` — schema.prisma:367,403–405. Tenant column design is correct and consistent.
- `UserSession` model exists (schema.prisma:414) but **zero writers** in `src/`.
- `LoginLog` model exists (schema.prisma:2129) but **zero writers**; only read by `api/reports/engagement/route.ts:24`.
- `OtpCode` has `attempts`/`maxAttempts` lockout fields (schema.prisma:444–445) — the verify route uses them.

**Tenancy resolution:**
- `getClientIdFromRequest` reads `x-tenant-slug`, else falls back to `DEFAULT_CLIENT_ID='deoleo'` — tenant.ts:20. Silent fallback = isolation risk (#23).
- `resolveSlugFromHostname` is pure, part-based, domain-agnostic, reserved-subdomain aware — tenant-resolution.ts:39. Good.
- `CLIENT_REGISTRY` is two hand-written configs in code; the file's own header says "in production these live in the database" — client-registry.ts:6. That DB move is 1.3 (#22).

**Auth flow:**
- `getAuthUser` trusts proxy `x-user-id`/`x-user-role` first, Bearer JWT fallback — auth.ts:154. clientId is **not** part of the token (`TokenPayload` = userId, role, partnerId — auth.ts:7).
- `verifyToken`/`generateToken`/`generateOTP`/bcrypt helpers are clean and testable; `signToken` is deprecated (auth.ts:172) but **still used** by verify-otp.

## Findings that change the task plan

### 🔴 F1 (High, 1.2 + 1.7) — `api/admin/users/[id]` is not tenant-scoped — cross-tenant read/write/delete
GET/PATCH/DELETE use `prisma.user.findUnique/update({ where: { id } })` with **no `clientId`** (users/[id]/route.ts:27,58,94). The list/create/bulk-edit siblings all scope by `clientId`; this one doesn't. Combined with clientId coming from a *header* (not the token), a `CLIENT_ADMIN` can read, edit the role/status of, or soft-delete **any user in any tenant** by guessing/holding an id. This is the concrete face of #23 (and #20). **Fix in 1.2 when touching the route; lock with the 1.7 isolation audit test.** Highest-priority item in P1.

### 🟠 F2 (Med, 1.1) — OTP send goes through the retired `notifications.ts`, not `msg91.ts`
`send-otp/route.ts:5` imports `sendOTP` from `@/lib/notifications`. Per the 0.4c decision (#21) MSG91 is the sole provider and `notifications.ts` senders are to be retired. `msg91.ts` is imported **nowhere** in `src`. 1.1 should route OTP through `msg91.ts` (the converged OTP path the decision calls for) rather than extend the retired one.

### 🟠 F3 (Med, 1.1) — duplicated OTP logic + divergent expiry; deprecated `signToken`
The routes inline `prisma.otpCode.create/findFirst` instead of `auth.ts`'s `storeOTP`/`verifyOTP`. Expiry diverges: route uses **6 h** (send-otp/route.ts:36) vs helper's **10 min** (auth.ts:36). verify-otp issues the token via deprecated `signToken` (verify-otp/route.ts:98), dropping `partnerId`. 1.1 should converge on one path and one expiry.

### 🟡 F4 (Low, 1.1) — OTP lookup not tenant-scoped
verify-otp finds the OTP by `phone` only (verify-otp/route.ts:38) before scoping the *user* by clientId. If the same phone exists in two tenants, the latest OTP across tenants can match. Low impact (still gated by user lookup) but worth scoping when 1.1 is touched.

### 🟡 F5 (Low, 1.1) — silent auto-registration
First OTP for an unknown phone auto-creates a `PENDING_VERIFICATION` user with role `SSS` (send-otp/route.ts:50). Likely intentional (self-enrollment funnel) but should be an explicit, confirmed design point, not an accident of the login route.

## Refined 1.1–1.9 to-do (supersedes the one-liners in MASTER-PLAN)

- **1.1** Converge OTP on `msg91.ts` (F2) + one expiry + drop `signToken` (F3) + tenant-scope the OTP lookup (F4); decide auto-registration explicitly (F5). Pure tests for token/otp; wiring test for the flow.
- **1.2** Add `clientId` scoping to `[id]` GET/PATCH/DELETE (**F1**); decide JWT-only vs persisted `UserSession` (model exists, unused) and implement the chosen one; keep `auth/me` + list/create/bulk-edit as-is (verify with tests).
- **1.3** Add `Client` model + migrate; backfill from `CLIENT_REGISTRY`; keep the registry shape as the seed. Solo task (schema migration on shared dev DB).
- **1.4** Read flags/branding from the `Client` row (depends 1.3); admin config UI (avoid pages under the user's revamp).
- **1.5** `lib/rbac/` permission catalog derived from the capability list (#3); pure.
- **1.6** `can(role, permission)` + configurable role→permission map; replace the 65 inline checks behind a flag (#2); depends 1.5.
- **1.7** Isolation audit test that asserts every tenant-scoped route filters by `clientId` (F1 is the first thing it must catch) + Prisma scoping helper (#23).
- **1.8** **Human-gate:** token↔tenant binding (#20) with the proxy owner — put `clientId` in the token vs keep header-trust. Pure compare once decided.
- **1.9** Write `LoginLog` + bump `lastLoginAt`/`loginCount` on successful login; optional `lib/audit` helper to DRY the inline `auditLog.create` calls.

### 🟠 F6 (Med, → 1.7) — `api/admin/banners` DELETE is not tenant-scoped (found by the 1.2a validation auditor)
`src/app/api/admin/banners/route.ts:81` does `prisma.bannerManagement.delete({ where: { id } })` with the id from a query param and **no `clientId`** — a CLIENT_ADMIN can hard-delete another tenant's banner by id. Same class as F1, different resource. **1.7's isolation audit test must enumerate ALL tenant-scoped routes and fail on this; fix it there.** (Note: this is a *hard* delete, unlike the user soft-delete — worth converting to soft-delete too.)

## Progress & validation log

| Task | Status | Gate (orchestrator) | Independent audit |
|---|---|---|---|
| 1.0 | ✅ done | n/a (audit) | n/a |
| 1.2a (F1 fix) | ✅ committed `341b9a3` | tsc 0 / lint clean / tests +11, no new reds | **PASS-WITH-NOTES** — confirmed all 3 handlers scoped & no-mutation; surfaced F6 (banners) + soft-deleted-target + findFirst-arg test-strengthening (folded into 1.7) |
| 1.1 (F2/F3/F4) | ✅ committed `4dd30d5` | tsc 0 / lint clean / tests +9, no new reds | **PASS-WITH-NOTES** — F3/F4 correct; surfaced **F7** (send-otp silent-failure) → fixed in **1.1a**; noted wiring tests are source-greps not behavioral |
| 1.1a (F7 fix) | ✅ committed `9c3d4f7` | tsc 0 / lint clean / +14 behavioral, no new reds | **PASS-WITH-NOTES** — fix correct, tests behavioral; note: 502 leaves orphaned OTP/user rows (deferred transactional reorder) |
| 1.7 (F6 + isolation) | ✅ committed `16a72b1` | tsc 0 / lint clean (banners `any` pre-existing) / +4, no new reds | **PASS-WITH-NOTES** — banners fix sound; audit heuristic was per-file (false-NEGATIVE on mixed files) → hardened in **1.7a** |
| 1.7a (audit hardening) | ✅ committed `5c96b21` | tsc 0 / lint clean / +2, no new reds | per-handler segmentation closes the false-negative; synthetic cases prove it; offender set still empty |
| 1.3 (Client model — code only) | ✅ committed `24613a4` | tsc 0 / lint clean / +23 | **PASS** — model faithful, secret excluded, id=slug consistent, migration additive |
| 1.3a (migration applied) | ✅ committed `efee563` | dev migration + backfill **verified on gifsy_dev** | **2 rows** (deoleo ACTIVE, clientb ONBOARDING), `msg91AuthKey` absent, nested JSON intact |

**1.3 migration — applied to dev (gifsy_dev) 2026-06-15.** Used **surgical diff-SQL** (`prisma migrate diff` → reviewed → applied in a txn with a `current_database='gifsy_dev'` guard), NOT `prisma migrate dev`: this dev DB has **no `_prisma_migrations` history** (db-push managed), so `migrate dev` would have **reset** it. Recorded in `prisma/migrations/add_client_tenant_table.sql` and in `DEV-DB.md` (new "Applying schema changes" section). Backfill fixed to reuse the adapter-configured `lib/prisma` singleton (1.3a).

**Wave-2 deferred follow-ups (tracked):**
- **1.1a orphaned rows** — on a 502/failed send, the OTP + provisional-user rows were already written. Transactional reorder (create-after-send, or compensating cleanup) — schedule with the OTP-window decision.
- **1.7 audit blind spot** — being closed by 1.7a (per-handler segmentation); residual: still string-based, not AST (a where-clause built via an external helper could slip).
- **1.3 invoicing bank details in JSON** — Gifsy's own seller bank fields live in the `invoicing` JSON column; if column-level access control is ever needed, that needs a separate table. Revisit if/when RBAC granularity (1.6) demands it.
| 1.5 (catalog) | ✅ committed `a8b2e6e` | tsc 0 (fixed union-type test) / lint clean / tests +17 | **PASS** — 17 §-refs verified 1:1 vs spec, union type exhaustive, unwired, helpers correct |

### 🟠 F7 (Med, → 1.1a) — `send-otp` reports success even when delivery didn't happen
`send-otp/route.ts:75` discards the `sendOtp` result, and `templateId` resolves to `''` for any tenant slug absent from `CLIENT_REGISTRY` — so an unregistered/mis-keyed tenant gets `200 {success:true,"OTP sent"}` while MSG91 sent nothing and the OTP row already exists (user can't log in, no error signal). Registered tenants (deoleo/clientb) unaffected. Fix in 1.1a: fail-fast when no templateId is configured (before writing rows) + check the `sendOtp` result; add a **behavioral** test (mock msg91+prisma) proving an unconfigured tenant gets no false success.

**Differential gate evidence (whole wave):** full `npm test` = 28 failed files / 105 failed tests = **exact match to baseline-red-snapshot.txt** (zero new reds, zero regressions); +37 new green tests; `tsc --noEmit` = 0 errors; lint clean on all wave files (pre-existing project-wide `any` debt untouched, matching surrounding convention).

**Deferred decisions raised by this wave (for just-in-time resolution):**
- **OTP validity window** — route uses 6 h, helper uses 10 min. Executor + I recommend **10 min** (6 h is a security anti-pattern). Decide when 1.1's follow-up / messaging convergence lands.
- **Auto-registration (F5)** — first OTP for an unknown phone silently creates a `PENDING_VERIFICATION/SSS` user. Confirm this is the intended self-enrollment funnel.
- **OTP channel routing** — `msg91.sendOtp` picks channel from the MSG91 template, so the request's `SMS`/`WHATSAPP` field is now cosmetic. If explicit per-channel OTP is required, needs separate templateIds. → P7 messaging.
- **1.5 taxonomy** (5 questions): sales data-scoping vs permission keys; single `kyc:approve` vs level-bound; per-feature-flag granularity; partner-app permissions; scheme rule-engine key. → resolve before 1.6 maps roles.

## Spec corrections emitted by this audit
- §01 / gap-register: confirm #2 (fixed `UserRole` enum), #3 (no permission catalog), #20 (clientId not in token), #22 (registry in code), #23 (silent `deoleo` fallback **+** un-scoped `[id]` route) all still **open** and now have file:line evidence.
- Note that `UserSession` and `LoginLog` tables exist but are **unwired** — the spec's "sessions / login audit" capability is modelled, not implemented.
