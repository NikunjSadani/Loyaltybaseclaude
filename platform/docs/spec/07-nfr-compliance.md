# Phase 3 — §07 Non-Functional Requirements & Compliance

## 1 · Security

- **AuthN:** OTP (MSG91) + JWT (`JWT_SECRET` **refuses to start if missing in prod**; dev uses
  an explicit insecure fallback). `FIXED_OTP=123456` is **dev-only** and must never reach
  prod Secret Manager.
- **Secrets:** GCP Secret Manager; SA key files + `push_secrets` gitignored; no hardcoded creds.
- **Input validation:** `zod` on many API routes (e.g. KYC). Coverage to audit.
- **Server-side session revocation (✅ P1):** `UserSession` is the source of truth for every
  authenticated request. Sessions are revocable instantly — logout, logout-all-devices, admin
  phone-change, and a GIFSY-only global kill switch (`force-logout-all`). 365-day sliding idle
  expiry (`expiresAt` bumped per request).
- **Token↔tenant binding + header-swap defence (✅ P1, gap #20 resolved):** `clientId` is now
  in the JWT and bound to the session at login. `getAuthUser` enforces subdomain==session-tenant
  for non-Gifsy sessions in the app layer — a valid token used on the wrong subdomain is
  rejected. Proxy continues to do coarse JWT verify.
- **AuthZ (✅ P1 engine done, enforcement flag-gated):** `lib/rbac/can.ts` — 71-permission
  catalog; default role→permission map; per-tenant overrides; `requirePermission` wired into all
  44 admin route files (additive; off by default via `RBAC_ENFORCEMENT` env +
  `features.rbacEnforcement`). Complete the pre-activation checklist in
  `reconcile/P1-identity-tenancy.md` before enabling.
- **⚠️ `DEMO_MODE` production risk:** `DEMO_MODE=true` trusts the `x-user-role` header —
  **never enable in production** (add to prod hardening checklist before go-live).

## 2 · Multi-tenant isolation

- **App-level row scoping** by `clientId` on every query; no DB-level enforcement (no Postgres
  RLS yet — future P8.6).
- **✅ P1 improvements (gap #23 reduced):**
  - Cross-tenant header-swap closed: `getAuthUser` enforces subdomain==session-tenant in-app
    (gap #23 header-swap + gap #20 proxy-trust both addressed).
  - Per-route `clientId` scoping fixed: `admin/users/[id]` (F1) and `admin/banners` DELETE (F6)
    were missing tenant filters — both corrected.
  - Isolation audit test (1.7/1.7a): per-handler heuristic that fails on routes missing
    `clientId` filters; runs as part of the test suite.
- **Residual gap #23:** still relies on per-query developer discipline for new routes; no Prisma
  auto-scoping middleware or Postgres RLS. Hardening tracked as P8.6.

## 3 · Privacy & data protection (India DPDP)

- **Consent:** `ConsentRecord` captured (e.g. at KYC, `KYC_CONSENT` OTP purpose).
- **Data-subject requests:** `DataRequest` supports `ACCESS / CORRECTION / DELETION /
  PORTABILITY` with a status lifecycle — good DPDP alignment.
- **→ Gap #24:** **erasure vs audit tension** — DPDP deletion requests conflict with append-only
  audit/ledger trails + `deletedAt` soft-delete. Define a retention + anonymisation policy
  (what is hard-deleted vs pseudonymised).
- **PII surface:** KYC docs (Aadhaar/PAN/GST/bank) in GCS; ensure signed-URL expiry + least-
  privilege bucket access (noted in `s3.ts`).

## 4 · Financial compliance

- **TDS:** `TdsRecord` (rate, section/`formType`, certificate). **→ Gap #25:** differentiate
  sections — direct **incentive** payouts (e.g. 194R) vs **visibility service** payments
  (e.g. 194C/194J); the two relationship types (§00) imply different tax treatment.
- **GST:** visibility **self-bill invoices** (`AutoInvoice`) compute GST from the outlet's
  **registration type** (Regular/Composition/Unregistered, captured at KYC — Gap #15).
  Composition/Unregistered = different/no GST. Validate the GST logic per type.
- **Payout audit trail:** UTR per payment, **duplicate-UTR detection**, `FundLedger` (client
  float) + `FundReceipt`. Visibility always a **separate UTR**.
- **Invoice integrity (Gap #8):** partner can edit `AutoInvoice.invoiceNumber` — needs
  uniqueness/format validation + lock-after-finalise.

## 5 · Auditability

- Append-only `AuditLog`, `LoginLog`, and per-aggregate `*StatusHistory` (KYC, redemption,
  ticket, visibility) — strong event trails. Ensure every state transition writes history.

## 6 · Performance & scale

- Schema is **well-indexed** (`clientId`, status, FKs, dates).
- Bulk flows are **batched** (sales/credits/visibility uploads, payout downloads).
- **→ Gap #26:** confirm **pagination** on list endpoints (outlets, transactions, tickets) —
  unbounded `findMany` won't scale per tenant.
- Image-hash dedupe guards visibility fraud at scale.

## 7 · Reliability & observability

- **Transactions** used for multi-write ops (KYC approve, credit confirm, redemption).
- **Idempotency:** dup-UTR detection helps; confirm upload re-submission safety.
- **`DEMO_MODE`** isolates external deps for demo/test.
- **→ Gap #27:** logging is `console.error` only — no structured logging / metrics / tracing /
  alerting documented. Define an observability baseline for prod.
