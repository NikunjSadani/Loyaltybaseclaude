# Reconcile — Task 0.0 · Shared infra (P0) vs spec §04

Audit of the cross-cutting building blocks every later phase reuses. Tag legend:
**VERIFY** (looks done — prove with a test) · **COMPLETE** (partial/stub/duplicated — finish/consolidate) · **BUILD** (missing).

> Plan against the spec, build against the code — where they disagree, the code wins and the spec is corrected.

## Shared-infra inventory

| # | Capability | File(s) | Tag | Evidence / note |
|---|---|---|---|---|
| A | Prisma client singleton (adapter-pg, build-time stub) | `lib/prisma.ts` | **VERIFY** | Singleton + `@prisma/adapter-pg`; build-time stub when no `DATABASE_URL`. Looks correct; no test asserts the singleton/stub behavior. |
| B | Client-side fetch wrapper + `ApiResponse<T>` | `lib/api-client.ts` | **VERIFY** | Central `api.get/post/...`; consolidates 3 old `authHeader()` copies. `Bearer` from `localStorage`. Has a test (`__tests__/api-client.test.ts`). |
| C | Server-side response helper (`ok`/`err`) | *(none — inlined per route)* | **COMPLETE** | Shape is consistent (`{success,data}`/`{success,error}`) but **duplicated ~100×** as local consts. → Task **0.2**: extract `lib/api-response.ts`, adopt for all new routes. |
| D | Auth: OTP/JWT/hash + `getAuthUser` | `lib/auth.ts` | **COMPLETE** | JWT issue/verify, bcrypt, DB-stored OTP. `getAuthUser` trusts proxy headers `x-user-id`/`x-user-role` first, `Bearer` fallback. **clientId NOT in token.** → 0.3 documents the contract; #20 (proxy-trust boundary) deferred to P1. |
| E | Tenant scoping entry point | `lib/tenant.ts`, `lib/platform/tenant-resolution.ts` | **COMPLETE** | `getClientIdFromRequest` reads `x-tenant-slug`, **falls back to `DEFAULT_CLIENT_ID='deoleo'`** when header absent. `resolveSlugFromHostname` is pure + part-based (domain-agnostic — good). ⚠️ Silent fallback to Deoleo on a missing header is a tenant-isolation risk → flag for #23 (P1). |
| F | Shared utils (currency=paise, points, dates, `paginate`, geo, FY, mask) | `lib/utils.ts` | **VERIFY** | `formatCurrency` expects **paise**; a `paginate(page,limit)` helper already exists (relevant to #26, P8). Pure — easy to lock with tests. |
| G | Object storage (GCS) | `lib/s3.ts` | **VERIFY (defer)** | Used by KYC/visibility uploads; deep-verify in P3 §3.1. |
| H | Messaging — **two stacks + a third OTP path** | `lib/msg91.ts`, `lib/notifications.ts`, `lib/auth.ts` | **COMPLETE (decision)** | `msg91.ts` = canonical MSG91 v5 (pure builders, DEMO_MODE, sender `GIFSY`). `notifications.ts` = *separate* axios gateway (`SMS_GATEWAY_URL`/`WHATSAPP_GATEWAY_URL`) **+ the DB `NotificationTemplate`/`NotificationQueue` model**. OTP exists in 3 places (auth DB-OTP, msg91 provider-OTP, notifications send). → **Gap #21 / human-gate decision** (see below). |
| I | Domain refs `loyaltybase.in` → `gifsy.in` | 8 src files | **COMPLETE (in progress)** | Gap #1. 12 occurrences, all comments/UI/seed/fixtures; logic is domain-agnostic. Executor task **0.4a** dispatched. |
| J | Dead `ROLES` const | `lib/auth.ts:176` | **COMPLETE** | `ROLES`/`Role` legacy enum; `\bROLES\b` matches only its own definition in `src`. Confirm `Role` *type* has no importers, then remove. |

## #21 — the messaging-path decision (needs human sign-off)
Resolving this is a P7 dependency but the fork should be **named now**. Options:
- **(rec) Canonical = `msg91.ts` for delivery + keep `notifications.ts`'s DB template/queue model for the engine.** Route all sends through MSG91; retire the duplicate axios gateway senders in `notifications.ts`; fold the 3 OTP paths into one. Build the P7 notification engine on top.
- Keep `notifications.ts` as the generic gateway and make MSG91 one adapter behind it.
- Defer entirely to P7 (risk: more code piles onto the fork meanwhile).

Not resolving here — flagged for the orchestrator to bring to the human at P0.4 / P7.

## P0 to-do refined from this audit
- **0.1** Establish green baseline (`npm test`/`tsc`/`lint`) + confirm env/DB (DB ✅ verified, 79 tables). *(run after 0.4a executor finishes to avoid file-state contention)*
- **0.2** Extract `lib/api-response.ts` (`ok`/`err`), unit-test, adopt for new routes (DRY; don't mass-rewrite existing — YAGNI).
- **0.3** Document the `getAuthUser` / `getClientIdFromRequest` contract (+ note the Deoleo-fallback risk for #23); add unit tests for the header-priority + fallback logic.
- **0.4a** #1 domain rename — *executor running*.
- **0.4b** Remove dead `ROLES` (after confirming `Role` type unused).
- **0.4c** #21 messaging decision — **escalate to human**.
- **0.5** Base portal layout/nav + UI-kit audit — render test + **human UI sign-off**.
