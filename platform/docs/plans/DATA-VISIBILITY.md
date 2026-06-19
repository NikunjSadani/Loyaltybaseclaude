# Data Visibility — what data each role sees on each page (the spec the E2E harness asserts)

> Created 2026-06-19. This is the **"expected"** that the automated E2E harness (gap #46) checks every page
> against — so "is this data real/correct?" is a defined fact, not a guess. **Cells marked 🟦 NEEDS-OWNER are
> product decisions only the owner can make** (collected in §3). Until answered, the page's "correct" is undefined.
> Source-of-truth flows: `spec/02` workflows + the phase reconcile docs + `KYC-APPROVAL-REVAMP.md`.

## 1. Principles (non-negotiable, every environment)
1. **Real data only.** Every page renders data from the backend for the current env's DB (`gifsy_dev`/`gifsy_staging`/`gifsy_prod`). **No hardcoded/demo values** (gap #40). Empty DB → honest empty state, never fabricated numbers.
2. **Scoped to the logged-in role + tenant** (below). A page in a role's nav must be served by endpoints that role is allowed to call (gap #41).
3. **Honest failures.** Unauthorised → clear 403; missing → clear empty/not-found. Never "fake success", never 401→demo fallback.

## 2. Role → scope (the model)
| Role | Scope |
|---|---|
| **GIFSY_ADMIN** (platform operator) | **cross-tenant** — all tenants (KYC final approval, payouts, platform users, TDS-194C) |
| **CLIENT_ADMIN** | their **whole tenant** (all outlets/partners/sales/tickets/credits/targets/visibility/invoices/KYC of that client) |
| **MIS_USER** | their tenant — 🟦 read-only? (decision Q5) |
| **SALES_*** (HO/STATE_HEAD/ASM/SO/ISR) | their **assigned outlets / downline team** (hierarchy-scoped) |
| **SSS / WHOLESALER / SUB_STOCKIST** (partner) | **only their own** — wallet, targets, tickets, rewards, visibility submissions, invoices |

## 3. 🟦 OPEN owner decisions (answer these → cells below become testable)
- **Q1 — Payouts:** who sees `/admin/payouts`? Today endpoints are `@Roles('GIFSY_ADMIN','MIS_USER')` but it's in the CLIENT_ADMIN nav → 403 (gap #41). Should CLIENT_ADMIN see their tenant's payout status (read), or is payout management Gifsy/MIS-only (then remove it from the CLIENT_ADMIN nav)?
- **Q2 — KYC final approval:** confirmed model = sales first-approve → **Gifsy bulk validation** (`/admin/kyc/approvals`). So is `/admin/kyc/approvals` a **Gifsy-only** surface (and CLIENT_ADMIN gets read-only visibility of the pending-Gifsy queue, no approve)? (gap #38)
- **Q3 — Gifsy operator login:** how does a GIFSY_ADMIN log in (which subdomain/path resolves `clientId='gifsy'`), and the localhost-dev path? (gap #39)
- **Q4 — Sales hierarchy visibility:** does a sales *manager* (ASM/STATE_HEAD) see their **whole downline's** outlets/tickets/KYC, or only directly-assigned? (affects tickets list, KYC list, dashboards)
- **Q5 — MIS_USER:** read-only across the tenant, or specific modules only?
- **Q6 — Cross-tenant Gifsy reads:** GIFSY sees ALL tenants' data on platform pages (tickets, KYC, payouts) — confirm, and confirm tenant data is **never** visible to another tenant.

## 4. Per-page expected visibility (skeleton — fill as each flow is verified)
`✅` = behavior confirmed at runtime · `◐` = partially confirmed · `🟦` = needs owner decision · `❌` = known broken (gap#)

| Page | Intended audience | Expected data | Status |
|---|---|---|---|
| `/auth/login` | all | OTP login, route by role to the right portal | ◐ 3/4 roles ✅; GIFSY ❌ #39 |
| `/admin/dashboard` | CLIENT_ADMIN/MIS | real tenant KPIs (partners/KYC/liability/fund) | ✅ (real seed data) |
| `/admin/dashboards/*` (kyc/payments/redemptions/engagement) | CLIENT_ADMIN/MIS | real tenant aggregates | ❌ fabricated #36/#40 |
| `/admin/kyc` (Submissions) | CLIENT_ADMIN/MIS (tenant) | tenant KYC list | ✅ (2 real); minor stale class filter #45 |
| `/admin/kyc/approvals` (bulk Gifsy) | 🟦 GIFSY (Q2) | PENDING_GIFSY queue, bulk verify | 🟦 unverified #38 |
| `/admin/payouts` | 🟦 (Q1) | tenant payout batches/txns | ❌ 403 for CLIENT_ADMIN #41 |
| `/admin/visibility` | CLIENT_ADMIN | tenant visibility submissions/upload | ✅ |
| `/admin/credits-payouts/*` | CLIENT_ADMIN | tenant credit batches/status | ✅ (status verified) |
| `/admin/targets`, `/admin/schemes`, `/admin/settings`, `/admin/users/outlets`, `/admin/hierarchy`, `/admin/sales`, `/admin/tds`, `/admin/invoices` | CLIENT_ADMIN | tenant data | ✅ (verified earlier) |
| `/admin/gifts` (catalogue) | CLIENT_ADMIN | tenant reward catalog | ◐ endpoint 200 (#35 fixed); page render unverified #46 |
| `/admin/tickets` | CLIENT_ADMIN/MIS (all tenant tickets) | every tenant ticket | ✅ (fixed #36, verified) |
| `/partner/dashboard` | partner | own targets/wallet/rank | ❌ fabricated available/rank #40 |
| `/partner/wallet` | partner | own balance + **own ledger** | ◐ balance real; statement fabricated #40 |
| `/partner/rewards` (+orders) | partner | catalog + own orders | ◐ unverified #46 |
| `/partner/targets`, `/partner/invoices`, `/partner/leaderboard` | partner | own data | ◐ targets/invoices ✅ earlier; leaderboard unverified |
| `/partner/support`, `/sales/support` | own tickets | own tickets only | ✅ (G verified) |
| `/sales/kyc` (+[id]) | sales (assigned) | assigned-outlet KYC; first-approve | ◐ list ✅; first-approve unverified #38 |
| `/sales/outlets`, `/sales/team*`, `/sales/dashboard`, `/sales/leaderboard` | sales (hierarchy) | assigned/team data | 🟦 Q4 + ◐ |
| `/sales/catalogue` (redemption) | sales | redeem for outlet (real balance) | ❌ hardcoded balance/OTP #36 |
| `/sales/visibility` (+submit) | sales | submissions; submit | ❌ dead submit button #36 |
| `/gifsy/*` (clients/users/outlet-types/settings) | GIFSY (cross-tenant) | platform data | ◐ unverified (login blocked #39) |

> This table is the harness's checklist: each row becomes an E2E assertion (right role → real expected data, no
> fabricated values, correct scoping, honest error). A row is "done" only when its E2E test passes.
