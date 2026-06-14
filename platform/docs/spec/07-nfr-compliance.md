# Phase 3 — §07 Non-Functional Requirements & Compliance

## 1 · Security

- **AuthN:** OTP (MSG91) + JWT (`JWT_SECRET` **refuses to start if missing in prod**; dev uses
  an explicit insecure fallback). `FIXED_OTP=123456` is **dev-only** and must never reach
  prod Secret Manager.
- **Secrets:** GCP Secret Manager; SA key files + `push_secrets` gitignored; no hardcoded creds.
- **Input validation:** `zod` on many API routes (e.g. KYC). Coverage to audit.
- **Boundary risk (Gap #20):** JWT verification + tenant injection are in an **external proxy**;
  in-app fallbacks (`DEFAULT_CLIENT_ID`, Bearer) are weaker. Add in-app middleware as
  defence-in-depth.
- **AuthZ:** coarse role checks today → configurable admin RBAC (Gap #2).

## 2 · Multi-tenant isolation

- **App-level row scoping** by `clientId` on every query; **no DB-level enforcement** (no RLS,
  no `Client` FK). A missed `clientId` filter = cross-tenant leak.
- **→ Gap #23 (High):** rely solely on developers remembering `getClientIdFromRequest` +
  `where: { clientId }`. Add a guardrail — Prisma middleware/extension that auto-scopes by
  tenant, or Postgres RLS — so isolation isn't per-query discipline.
- Token↔tenant binding depends on the proxy (Gap #20).

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
