# Gifsy / LoyaltyBase — Platform Handoff

**Date:** June 2026  
**Status:** Sales module fully wired to live APIs. Zero mock data remaining across all 16 sales pages.

---

## 1. Project Overview

Multi-tenant B2B loyalty platform for FMCG brands. Sales reps (XSR → SO → ASM → RSM → ZNM → NSM) enrol retail outlets via KYC, track targets, and redeem gift rewards on behalf of partners. Each brand runs as a separate tenant (`clientId`).

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15 App Router (`platform/`) |
| API Routes | Next.js API Routes (same repo, `platform/src/app/api/`) |
| Database | PostgreSQL via Prisma ORM |
| Auth | JWT stored in `localStorage`; `Authorization: Bearer <token>` header |
| Secrets | GCP Secret Manager |
| OTP (dev only) | `FIXED_OTP=123456` — never in production |

---

## 3. Repository Structure

```
Loyaltybaseclaude/
├── platform/                  # Next.js frontend + API routes
│   └── src/app/
│       ├── api/               # Next.js API routes
│       │   ├── auth/          # /me, /send-otp, /verify-otp
│       │   ├── kyc/           # KYC CRUD + approval endpoints
│       │   ├── sales/         # team, outlets, leaderboard
│       │   ├── visibility/    # submissions, outlet-statuses
│       │   ├── tickets/       # support tickets
│       │   ├── rewards/       # catalog, redeem, orders
│       │   ├── wallet/        # balance, transactions
│       │   ├── schemes/       # scheme targets + calculate
│       │   ├── payouts/       # batches, fund, reconciliation
│       │   ├── reports/       # KYC, billing, engagement, TDS
│       │   └── admin/         # user mgmt, settings, banners
│       └── sales/             # 16 sales-facing pages (all wired)
│           ├── dashboard/
│           ├── kyc/           # list, [id], [id]/edit, [id]/ledger, new
│           ├── team/          # list, [memberId], [memberId]/outlets
│           ├── leaderboard/
│           ├── outlets/
│           ├── tasks/
│           ├── catalogue/
│           ├── visibility/
│           ├── support/
│           └── profile/
└── api/                       # Legacy NestJS — superseded by platform/src/app/api
```

---

## 4. Auth Pattern

```ts
const token = localStorage.getItem('token') ?? '';
fetch('/api/some/endpoint', {
  headers: { Authorization: `Bearer ${token}` },
});
```

JWT decoded server-side by `getAuthUser(req)` in `platform/src/lib/auth.ts`.  
Payload shape: `{ userId, role, clientId }`.

---

## 5. Sales Hierarchy

```
NSM -> ZNM -> RSM -> ASM -> SO -> XSR
```

- `SalesUser.reportingToId` links each member to their manager.
- `HierarchyLevel.code` is the role code (`SO`, `ASM`, etc.).
- `getRole()` reads from `localStorage` — used client-side throughout all sales pages.

---

## 6. All 16 Sales Pages — API Wiring

| # | Route | API Endpoint(s) | Notes |
|---|-------|----------------|-------|
| 1 | `sales/dashboard` | `GET /api/sales/outlets` | Target KPI config uses outlet's `beat/district/state`; falls back to defaults when no outlets loaded |
| 2 | `sales/kyc` | `GET /api/kyc` + `GET /api/sales/team` | Manager roles get a team member filter dropdown |
| 3 | `sales/kyc/[id]` | `GET /api/kyc/[id]` | Approval buttons call `/first-approve` (SO/ASM/RSM) or `/approve` (Gifsy Admin) |
| 4 | `sales/kyc/[id]/edit` | `GET /api/kyc/[id]` + `PATCH /api/kyc/[id]` | Full form hydration from API |
| 5 | `sales/kyc/[id]/ledger` | `GET /api/kyc/[id]/ledger` | Date range defaults to current month; Excel export via `xlsx` |
| 6 | `sales/kyc/new` | `GET /api/sales/outlets` + `POST /api/kyc` | Outlet picker + phone conflict detection from live outlet data |
| 7 | `sales/team` | `GET /api/sales/team` | Shows direct reports; per-member outlet/KYC counts default to 0 — no stats endpoint yet |
| 8 | `sales/team/[memberId]` | `GET /api/sales/team/[memberId]` | Outlet list + activity from API |
| 9 | `sales/team/[memberId]/outlets` | `GET /api/sales/team/[memberId]` + `GET /api/sales/team/[memberId]/outlets` | Period filter + per-outlet KPI bars |
| 10 | `sales/leaderboard` | `GET /api/sales/leaderboard?scope=rm\|state\|national` | Rank change = delta vs prior month's final rank |
| 11 | `sales/outlets` | `GET /api/sales/outlets` + `GET /api/visibility/outlet-statuses` | Visibility status badge overlaid on each outlet |
| 12 | `sales/tasks` | `GET /api/sales/outlets` + `GET /api/visibility/outlet-statuses` | Task groups (Re-KYC, pending KYC, visibility, approvals) built from live data |
| 13 | `sales/catalogue` | `GET /api/sales/outlets` + `GET /api/rewards/catalog` | Outlet pre-selected from `?outletId=` URL param; `balance` defaults to 0 — wallet not in outlets API |
| 14 | `sales/visibility` | `GET /api/visibility/submissions` + `POST /api/visibility/submit` | Camera + GPS capture; per-outlet status via outlet-statuses endpoint |
| 15 | `sales/support` | `GET /api/tickets` + `POST /api/tickets` + `GET /api/sales/outlets` | Outlet-linked and personal (self) ticket types |
| 16 | `sales/profile` | `GET /api/auth/me` | Role label derived from `ROLE_LABELS[user.role]`; outlet/KYC stats default to 0 |

---

## 7. API Routes — Quick Reference

### Auth

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/send-otp` | Send OTP to phone number |
| POST | `/api/auth/verify-otp` | Verify OTP, returns JWT |
| GET | `/api/auth/me` | Current user profile + `salesUser` relation |

### KYC

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/kyc` | Any sales role | List submissions scoped by role |
| POST | `/api/kyc` | XSR / SO | Submit new KYC |
| GET | `/api/kyc/[id]` | Any | KYC detail with documents |
| PATCH | `/api/kyc/[id]` | `GIFSY_ADMIN` only | Update status / reviewer notes |
| POST | `/api/kyc/[id]/first-approve` | SO / ASM / RSM | Field approval; advances to `PENDING_GIFSY` |
| POST | `/api/kyc/[id]/approve` | `GIFSY_ADMIN` | Final approval; activates partner + creates wallet |
| POST | `/api/kyc/[id]/reject` | SO+ or admin | Reject with reason |
| GET | `/api/kyc/[id]/ledger` | Any | Wallet transaction ledger for outlet |
| POST | `/api/kyc/not-interested` | XSR / SO | Mark outlet as not interested |

### KYC Status Flow

```
NOT_STARTED
  -> SUBMITTED              (XSR/SO files the KYC)
  -> PENDING_SO_APPROVAL
  -> PENDING_ASM_APPROVAL   (SO calls /first-approve)
  -> PENDING_RSM_APPROVAL   (ASM calls /first-approve)
  -> PENDING_GIFSY          (RSM calls /first-approve)
  -> APPROVED               (Gifsy Admin calls /approve -> activates partner + wallet)

At any stage:
  -> REJECTED
  -> RESUBMISSION_REQUIRED
  -> RE_KYC_REQUIRED
```

### Sales

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/sales/team` | Current user's direct reports |
| GET | `/api/sales/team/[memberId]` | Member detail + outlets + activity feed |
| GET | `/api/sales/team/[memberId]/outlets` | Member's assigned outlet list |
| GET | `/api/sales/outlets` | Current user's assigned outlets |
| GET | `/api/sales/leaderboard?scope=rm\|state\|national` | Peers ranked by monthly target achievement % |

### Outlet Object Shape (from `/api/sales/outlets`)

```ts
{
  id, kycId, outletCode, name, mobile,
  location,       // city
  beat,           // sub-district / beat area
  district, state,
  type,           // 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST'
  kycStatus,      // latest KYC submission status
  kycSubmittedAt,
  targetPct,
}
// NOTE: wallet balance is NOT included — use GET /api/kyc/[id]/ledger
```

### Visibility

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/visibility/submissions` | List submissions for current user |
| POST | `/api/visibility/submit` | Upload photos + GPS coordinates |
| GET | `/api/visibility/outlet-statuses?codes=&month=` | Batch status lookup by outlet codes + month |
| POST | `/api/visibility/submissions/[id]/approve` | Admin approve |
| POST | `/api/visibility/submissions/[id]/reject` | Admin reject with reason |

### Support Tickets

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/tickets` | List user's tickets |
| POST | `/api/tickets` | Create ticket |
| GET / PATCH | `/api/tickets/[id]` | Detail / update |
| POST | `/api/tickets/[id]/escalate` | Escalate |
| GET / POST | `/api/tickets/[id]/messages` | Thread messages |

### Rewards / Catalogue

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/rewards/catalog` | Gift catalogue items |
| POST | `/api/rewards/redeem` | Initiate redemption (triggers OTP) |
| POST | `/api/rewards/redeem/confirm` | Confirm with OTP |
| GET | `/api/rewards/orders` | Redemption order history |

---

## 8. Known Gaps — APIs Not Yet Built

| Gap | Pages Affected | Current Behaviour |
|-----|---------------|------------------|
| No per-member stats endpoint | `sales/team` | Outlet count, KYC pending/done, and target % all show 0 per team member card |
| No wallet balance in outlets API | `sales/catalogue` | `balance: 0` on outlet selector; fetch real balance from `/api/kyc/[id]/ledger` when an outlet is selected |
| No per-user geographic target config API | `sales/dashboard`, `sales/outlets`, `sales/team/[memberId]/outlets` | KPI config falls back to first outlet's `beat/district/state`; bars show 0 until outlets load |
| No per-outlet KPI achievement breakdown | `sales/kyc/[id]`, `sales/outlets` | KPI achievement bars render 0 for all real outlet IDs |
| Profile outlet/KYC/visibility counts | `sales/profile` | All three stat counters show 0 |

---

## 9. Security Constraints

- `FIXED_OTP=123456` is dev-only — must never appear in production Secret Manager
- All secrets managed via GCP Secret Manager; `push_secrets.py` and service account key files are gitignored
- `JWT_SECRET` must never fall back to a hardcoded value in production — server must refuse to start if unset
- `api/scripts/push-secrets.sh` uses interactive prompts only; no hardcoded credentials; file is in `api/.gitignore`
- `.gitignore` excludes: `node_modules/`, `dist/`, `.next/`, `.env*`, `gifsy-platform-*.json`, `kwality-gift-*.json`, `push_secrets.py`

---

## 10. Admin Module — Credits & Payouts

Five pages under `admin/credits-payouts/`:

| Page | Route | Role | Description |
|------|-------|------|-------------|
| Hub | `/admin/credits-payouts` | CLIENT_ADMIN + GIFSY_ADMIN | Landing with cards linking to upload, status, fields |
| Fields | `/admin/credits-payouts/fields` | CLIENT_ADMIN + GIFSY_ADMIN | Create / toggle credit fields (KPI columns) |
| Upload | `/admin/credits-payouts/upload` | CLIENT_ADMIN + GIFSY_ADMIN | 3-step: download template → upload → preview → confirm |
| Status | `/admin/credits-payouts/status` | CLIENT_ADMIN + GIFSY_ADMIN | View confirmed batches, initiate reversals |
| Payout | `/admin/credits-payouts/payout` | **GIFSY_ADMIN only** | Generate payout files, upload UTR results, approve reversals |

**Storage:** All five pages use localStorage-backed lib functions (`@/lib/credits-payouts-*`). The libs are explicitly labelled as "demo" with the note: _"In production these would be persisted via API routes to the database."_ No Prisma models exist yet for `CreditBatch` or `CreditField` — do not attempt to wire these pages to `/api/payouts/batches` (that endpoint uses a different `PayoutBatch` schema).

**Tests:** 10 test files, **240 tests, all passing**:

```
src/lib/__tests__/credits-payouts-fields.test.ts
src/lib/__tests__/credits-payouts-store.test.ts
src/lib/__tests__/credits-payouts-parser.test.ts
src/lib/__tests__/credits-payouts-notify.test.ts
src/lib/__tests__/credits-payouts-payout.test.ts
src/lib/__tests__/credits-payouts-reversal.test.ts
src/lib/__tests__/credits-payouts-template.test.ts
src/lib/__tests__/credits-payouts-utr.test.ts
src/lib/__tests__/credits-payouts-pages.test.ts
src/lib/__tests__/credits-payouts-phase2-pages.test.ts
```

Run them with:

```bash
cd platform
npx vitest run src/lib/__tests__/credits-payouts-*.test.ts
```

**Known pre-existing test failures (unrelated to credits-payouts):** 80 tests in `sales/kyc/__tests__/` and `partner/targets/__tests__/` fail due to RTL rendering issues — these pre-date all credits-payouts work and are not regressions.

---

## 11. TypeScript

Zero errors across all pages (sales + admin). Verify with:

```bash
cd platform
npx tsc --noEmit
```

---

## 12. Dev Setup

```bash
cd platform
npm install
cp .env.example .env.local
# Required: DATABASE_URL, JWT_SECRET, NEXT_PUBLIC_API_URL

npm run dev   # http://localhost:3000
```

No separate backend process — frontend and all API routes run from the same Next.js server.
