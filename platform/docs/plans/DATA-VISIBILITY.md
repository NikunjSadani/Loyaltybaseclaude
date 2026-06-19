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
| **MIS_USER** | their tenant — **read-only** (resolved Q5; tenant-side reporting role) |
| **SALES_*** (HO/STATE_HEAD/ASM/SO/ISR) | their **assigned outlets / downline team** (hierarchy-scoped) |
| **SSS / WHOLESALER / SUB_STOCKIST** (partner) | **only their own** — wallet, targets, tickets, rewards, visibility submissions, invoices |

## 3. ✅ RESOLVED owner decisions (2026-06-19) — these define the harness "expected"
All six who-sees-what questions are answered. The harness asserts exactly these.

- **Q1 — Payouts → GIFSY_ADMIN-only.** `/admin/payouts` is a platform-operator surface. **Remove it from the CLIENT_ADMIN nav** entirely, and **remove `MIS_USER` from the payout endpoints** (MIS is tenant-side, see Q5). Net: payout endpoints = `@Roles('GIFSY_ADMIN')`. (fixes gap #41)
- **Q2 — KYC final approval → Gifsy-only, no client access.** Model = sales first-approve → **Gifsy bulk validation** (`/admin/kyc/approvals`). `/admin/kyc/approvals` is **GIFSY_ADMIN-only**; **no CLIENT_ADMIN access at all** (not even read-only). (relates gap #38)
- **Q3 — Gifsy login → dedicated subdomain + dev override; real-login only.** Staging/prod: a Gifsy subdomain (`gifsy.<domain>` / `admin.<domain>`) resolves `clientId='gifsy'` from host. Localhost dev: an explicit `clientId` field/override on the login form (real login, real token — **NOT** the persona/view switcher, which never counts as "done"). (fixes gap #39)
- **Q4 — Sales hierarchy → split.** A sales **manager** (ASM/STATE_HEAD/HO) sees the **whole downline's outlets + KYC** (recursive roll-up). **Support tickets are individual** — each user sees **only their own** raised tickets (tickets are a personal support channel, not team-rolled-up).
- **Q5 — MIS_USER → tenant-side, read-only.** Belongs to a tenant; read-only across that one tenant's modules. (⇒ removed from payouts per Q1.)
- **Q6 — Cross-tenant → Gifsy sees all; tenants isolated.** GIFSY_ADMIN (and Gifsy-side roles) read across **all** tenants on platform surfaces; every tenant role is hard-scoped to its own `clientId` — cross-tenant access is a **test failure**. **194C** (Gifsy's TDS) is computed **platform-wide per-PAN across tenants** → it lives **only** on the Gifsy cross-tenant surface, never on a tenant screen (a tenant sees only its own **194R**).

> **Deferred (separate unit, not blocking):** a *configurable* RBAC admin portal (heads define custom sub-roles/permissions) + the first-admin provisioning chain (seed bootstrap Gifsy super-admin → Gifsy creates tenant admins → tenant admin creates sub-users). For now the harness uses the **fixed built-in roles** above. Tracked in `gap-register` (#47).

## 4. Per-page expected visibility (skeleton — fill as each flow is verified)
`✅` = behavior confirmed at runtime · `◐` = partially confirmed · `🟦` = needs owner decision · `❌` = known broken (gap#)

| Page | Intended audience | Expected data | Status |
|---|---|---|---|
| `/auth/login` | all | OTP login, route by role to the right portal; GIFSY via subdomain/dev clientId override (Q3, real login only) | ◐ 3/4 roles ✅; GIFSY ❌ #39 |
| `/admin/dashboard` | CLIENT_ADMIN/MIS | real tenant KPIs (partners/KYC/liability/fund) | ❌ E2E baseline: still renders demo **"4,821"** (#40) — was wrongly ✅ |
| `/admin/dashboards/*` (kyc/payments/redemptions/engagement) | CLIENT_ADMIN/MIS | real tenant aggregates | ❌ fabricated #36/#40 |
| `/admin/kyc` (Submissions) | CLIENT_ADMIN/MIS (tenant) | tenant KYC list | ✅ (2 real); minor stale class filter #45 |
| `/admin/kyc/approvals` (bulk Gifsy) | **GIFSY only** (Q2; no client access) | PENDING_GIFSY queue, bulk verify | ❌ verify Gifsy-only + cross-tenant #38 |
| `/admin/payouts` | **GIFSY only** (Q1; remove from CLIENT_ADMIN nav, drop MIS) | all-tenant payout batches/txns | ❌ make Gifsy-only; CLIENT_ADMIN must 403/no-nav #41 |
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

> **Live status = the E2E harness, not this table.** `platform/e2e` (`npm run e2e`) is the source of truth;
> hand-edited cells drift. **Baseline 2026-06-19: 36/36 GREEN** (5 roles incl. GIFSY + clientb). The original
> reds are all remediated: #40 fabricated data (partner/sales identity via `/partner/me`, admin KPIs real),
> #41 role guards + Q1 payouts GIFSY-only, #39 GIFSY login (dev clientId override), cross-tenant isolation
> BOTH directions (2nd tenant `clientb` seeded with data), and the **partner redemption money path** (#50 —
> was 100% broken). Write-persistence covered for tickets + redemption. **Still NOT covered (open):** most
> non-anchor pages, the OTHER write flows (visibility/submit + KYC — proxy-excluded/dead, #36/#38), the gifsy
> console real data (mock, #49), sales-manager downline (Q4 — only an SO seeded), and **staging** (env-support
> TODO). A green harness = "the asserted slices work", NOT "every page works".
