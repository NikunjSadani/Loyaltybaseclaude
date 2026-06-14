# Phase 2 — §03 Data Model

~90 Prisma models. Documented C4-style: a **high-level aggregate map**, then **per-cluster
ERDs**, then **cross-cutting data patterns & gaps**. Relationship notation: `||--o{` = one-to-
many, `||--||` = one-to-one, `}o--o{` = many-to-many. Lifecycles (status enums) live in §02.

---

## A · High-level aggregate map

`User` is the identity hub (tenant-scoped by `clientId`); it specialises into a Partner or a
Sales user. Value flows: Outlet → KYC → credentials; uploads → Credits → Wallet → Redemption.

```mermaid
erDiagram
    USER ||--o| CHANNEL_PARTNER : "is-a (1:1)"
    USER ||--o| SALES_USER : "is-a (1:1)"
    CHANNEL_PARTNER ||--o{ OUTLET : owns
    CHANNEL_PARTNER ||--|| WALLET : has
    SALES_USER ||--o{ SALES_USER_ASSIGNMENT : covers
    OUTLET ||--o{ SALES_USER_ASSIGNMENT : "assigned via"
    USER ||--o{ KYC_SUBMISSION : submits
    CHANNEL_PARTNER ||--o{ KYC_SUBMISSION : "for"
    SCHEME ||--o{ SCHEME_ENROLLMENT : has
    CREDIT_BATCH ||--o{ CREDIT_PAYOUT_ENTRY : produces
    WALLET ||--o{ POINTS_LEDGER : records
    CHANNEL_PARTNER ||--o{ REDEMPTION_ORDER : places
    CHANNEL_PARTNER ||--o{ PAYOUT_TRANSACTION : "paid via"
    CHANNEL_PARTNER ||--o{ VISIBILITY_SUBMISSION : submits
    CHANNEL_PARTNER ||--o{ AUTO_INVOICE : "self-billed"
```

---

## B · Per-cluster ERDs

### B1 · Identity, Partners, Sales, KYC

```mermaid
erDiagram
    USER ||--o| CHANNEL_PARTNER : "1:1"
    USER ||--o| SALES_USER : "1:1"
    USER ||--o{ USER_SESSION : ""
    USER ||--o{ OTP_CODE : ""
    PARTNER_CLASS_CONFIG ||--o{ CHANNEL_PARTNER : classifies
    PARTNER_CLASS_CONFIG ||--o{ TIER_CONFIG : defines
    TIER_CONFIG ||--o{ CHANNEL_PARTNER : "current tier"
    CHANNEL_PARTNER ||--o{ PARTNER_TIER_HISTORY : ""
    CHANNEL_PARTNER ||--o{ OUTLET : owns
    OUTLET_TYPE ||--o{ OUTLET : types
    OUTLET ||--o{ OUTLET_GEO_HISTORY : ""
    SALES_HIERARCHY_LEVEL ||--o{ SALES_USER : "level of"
    SALES_USER ||--o{ SALES_USER : "reports to (self-ref)"
    SALES_USER ||--o{ SALES_USER_ASSIGNMENT : ""
    KYC_SUBMISSION ||--o{ KYC_DOCUMENT : ""
    KYC_SUBMISSION ||--o{ KYC_STATUS_HISTORY : ""
    USER ||--o{ CONSENT_RECORD : ""
    USER ||--o{ DATA_REQUEST : ""
```

### B2 · Programs & Value (Schemes, Targets, Wallet, Rewards)

```mermaid
erDiagram
    SCHEME ||--o{ SCHEME_RULE : ""
    SCHEME ||--o{ SCHEME_ELIGIBILITY : ""
    SCHEME ||--o{ SCHEME_ENROLLMENT : ""
    SCHEME ||--o{ SCHEME_TARGET : ""
    SCHEME ||--o{ TARGET : ""
    TARGET ||--o{ TARGET_ACHIEVEMENT : ""
    WALLET ||--o{ WALLET_TRANSACTION : ""
    WALLET ||--o{ POINTS_LEDGER : ""
    POINT_EXPIRY_CONFIG ||--o{ POINTS_LEDGER : governs
    REWARD_CATEGORY ||--o{ REWARD_CATALOG : ""
    REWARD_CATALOG ||--o{ REWARD_INVENTORY : ""
    REWARD_CATALOG ||--o{ REDEMPTION_ORDER : ""
    REDEMPTION_ORDER ||--o{ REDEMPTION_STATUS_HISTORY : ""
```

### B3 · Finance (Credits, Payouts, Invoicing)

```mermaid
erDiagram
    CREDIT_FIELD ||--o{ CREDIT_BATCH : "parameter of"
    CREDIT_BATCH ||--o{ CREDIT_PAYOUT_ENTRY : ""
    CREDIT_BATCH ||--o{ CREDIT_REVERSAL : ""
    CREDIT_PAYOUT_DOWNLOAD ||--o{ CREDIT_PAYOUT_ENTRY : groups
    PAYOUT_BATCH ||--o{ PAYOUT_TRANSACTION : ""
    PAYOUT_TRANSACTION ||--|| TDS_RECORD : ""
    REDEMPTION_ORDER ||--o| PAYOUT_TRANSACTION : "INR redemption"
    FUND_LEDGER }o--|| CHANNEL_PARTNER : "client float (by clientId)"
    CHANNEL_PARTNER ||--o{ AUTO_INVOICE : "self-billed"
```

> **Two payout entry types** (Gap #5): `CREDIT_PAYOUT_ENTRY` (push awards, `Decimal` INR) vs
> `PAYOUT_TRANSACTION` (pull redemptions, integer paise). See money-unit gap below.

### B4 · Visibility

```mermaid
erDiagram
    VISIBILITY_PROGRAM ||--o{ VISIBILITY_SUBMISSION : ""
    VISIBILITY_SUBMISSION ||--o{ VISIBILITY_APPROVAL : ""
    VISIBILITY_SUBMISSION ||--o{ VISIBILITY_FRAUD_LOG : ""
    VISIBILITY_IMAGE_HASH }o--o{ VISIBILITY_SUBMISSION : "dedupe"
    OUTLET_VISIBILITY_UPLOAD_BATCH ||--o{ OUTLET_VISIBILITY_RECORD : "(admin-upload mode)"
    OUTLET ||--o{ VISIBILITY_SUBMISSION : ""
```

---

## C · Cross-cutting data patterns & gaps

- **`clientId: String` denormalised on ~every table** for tenant scoping, but **no `Client`/
  `Tenant` model or FK** exists — tenant config lives in code (`CLIENT_REGISTRY`). Integrity of
  `clientId` is unenforced (Gaps #2, tenancy).
- **JSON-blob configs in `ProgramSetting`** (hierarchy, target-config, kpi-defs, banners, gifts)
  shadow relational models (`SalesUser`, `Target`, …). Two sources of truth per domain → drift
  (→ Gap #18). Decide blob vs relational per domain.
- **Inconsistent money units** — Payouts use **integer paise** (`amountPaise`), Credits use
  **`Decimal` INR** (`amountInr`, `totalPayoutInr`). Mixing risks rounding/conversion bugs at
  the Credits↔Payouts boundary (→ Gap #19).
- **Soft-delete (`deletedAt`)** on most aggregates but not all (e.g. ledger/history tables are
  append-only) — document the policy.
- **History/audit tables** are consistent and good: `*StatusHistory`, `AuditLog`, `LoginLog`,
  `*AuditLog` — append-only event trails per aggregate.
- **`Wallet` write-paths** — only redemption debits it; no credit path writes it (Gap #16).
