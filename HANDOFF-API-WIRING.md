# API Wiring Audit — Handoff Brief

## What This Is
Complete audit of all 70 Next.js pages in platform/src/app — which use real API calls
vs mock/hardcoded data. Use this to resume wiring work without re-running the audit.

Last audited: 2026-06-13

---

## Summary Counts
| Status | Count |
|--------|-------|
| Fully wired (real API, no mock) | 15 |
| Partial (API + mock fallback) | 13 |
| Pure mock (no API call at all) | 17 |
| Not started / static shell | 25 |
| **Total pages** | **70** |

---

## Central API Client
**Status: BUILT** at `platform/src/lib/api-client.ts`

Previously, `authHeader()` was copy-pasted in 3 separate files:
- `src/lib/banner.ts`
- `src/lib/task-config.ts`
- `src/lib/visibility-upload.ts`

All pages should now import from `api-client.ts`:
```typescript
import { api } from '@/lib/api-client'
const result = await api.get<MyType>('/api/some-endpoint')
```
Tests at: `src/lib/__tests__/api-client.test.ts`

---

## Partner Pages (current focus)

| Page | Status | Notes |
|------|--------|-------|
| partner/invoices | DONE | GET /api/sales/invoices |
| partner/invoices/[id] | DONE | GET /api/partner/invoices/[id] |
| partner/visibility | DONE | fetches visibility submissions |
| partner/payouts | DONE | just redirects to /partner/wallet |
| partner/dashboard | PARTIAL | loads OUTLET_ACHIEVEMENTS mock first, then patches from /api/partner/targets |
| partner/targets | PARTIAL | same leaderboard pattern as dashboard |
| partner/leaderboard | PARTIAL | fetch('/api/leaderboard') with silent mock fallback |
| partner/wallet | PARTIAL | huge MOCK_BALANCE + MOCK_TRANSACTIONS, has ApiWalletBalance type — needs /api/wallet wiring |
| partner/rewards/orders | PARTIAL | fetch('/api/rewards/orders') but mock fallback |
| partner/profile | MOCK | no API call, all hardcoded profile data. Needs GET /api/auth/me or similar |
| partner/rewards | MOCK | loads from lib/gifts (localStorage), needs GET /api/rewards/catalog |
| partner/support | STATIC | no data, appears to be a static page (ticket form etc.) — decide if wiring needed |

### Partner API Routes Available (backend ready)
- GET /api/partner/targets — scheme targets for logged-in partner
- GET /api/wallet — wallet balance (flat response, no nesting under .balance)
- GET /api/wallet/transactions — transaction history
- GET /api/rewards/catalog — gift catalogue
- GET /api/rewards/orders — orders list
- POST /api/rewards/orders — place order
- POST /api/rewards/redeem — redeem points
- GET /api/leaderboard — leaderboard data
- GET /api/auth/me — current user session

---

## Admin Pages

| Page | Status | Notes |
|------|--------|-------|
| admin/invoices | DONE | GET /api/sales/invoices |
| admin/kyc/[id] | DONE | GET/PUT /api/kyc/[id] |
| admin/outlets | DONE | fetches outlet data |
| admin/payouts | DONE | GET /api/payouts/batches + transactions |
| admin/payouts/fund | DONE | GET /api/payouts/fund |
| admin/reports | DONE | fetch(report.endpoint) — dynamic |
| admin/schemes/[id] | DONE | GET /api/schemes/[id] |
| admin/settings | DONE | GET /api/admin/settings |
| admin/visibility | DONE | GET /api/visibility/* |
| admin/approvals | PARTIAL | GET /api/kyc?status=PENDING_GIFSY + mock fallback |
| admin/kyc | PARTIAL | mapApiKyc() but falls back to ALL_KYC (12 hardcoded entries) |
| admin/sales | PARTIAL | GET /api/admin/sales/batches + MOCK_OUTLETS from targets.ts |
| admin/users/outlets | PARTIAL | fetch + mock mix |
| admin/banners | MOCK | uses fetchBanners() from lib/banner.ts but page itself has mock state |
| admin/dashboard | MOCK | BIGGEST GAP — KPI cards, growth metrics, schemes, payouts, territory — ALL hardcoded. Backend: /api/reports/* exists |
| admin/invoices/upload | MOCK | upload flow, has mock state |
| admin/schemes/[id]/enrollments | MOCK | hardcoded enrollment list |
| admin/targets | MOCK | SEED_CONFIGS, MOCK_OUTLETS, DEFAULT_PARAMS all hardcoded |
| admin/targets/upload | MOCK | upload mock state |
| admin/credits-payouts | NOT STARTED | feature shell, no data |
| admin/credits-payouts/* (4 sub-pages) | NOT STARTED | |
| admin/dashboards/engagement | NOT STARTED | /api/reports/engagement exists |
| admin/dashboards/kyc | NOT STARTED | /api/reports/kyc-status exists |
| admin/dashboards/payments | NOT STARTED | /api/reports/billing-trends exists |
| admin/dashboards/redemptions | NOT STARTED | |
| admin/gifts | NOT STARTED | |
| admin/hierarchy | NOT STARTED | |
| admin/schemes | NOT STARTED | GET /api/schemes exists |
| admin/tickets | NOT STARTED | GET /api/tickets exists |

---

## Sales Pages

| Page | Status | Notes |
|------|--------|-------|
| sales/kyc/new | DONE | POST /api/kyc + consent + not-interested |
| sales/kyc/[id] | PARTIAL | GET /api/kyc/[id] + mock mix |
| sales/kyc/[id]/edit | PARTIAL | GET + PUT /api/kyc/[id] + mock |
| sales/profile | PARTIAL | fetch + mock mix |
| sales/visibility | PARTIAL | fetch + mock mix |
| sales/catalogue | MOCK | uses loadGifts() from localStorage |
| sales/dashboard | MOCK | hardcoded KPIs |
| sales/kyc | MOCK | hardcoded KYC list (no fetch) |
| sales/leaderboard | MOCK | hardcoded leaderboard data |
| sales/outlets | MOCK | MOCK_OUTLETS from targets.ts |
| sales/support | MOCK | static/mock tickets |
| sales/tasks | MOCK | hardcoded task list |
| sales/team | MOCK | hardcoded team members |
| sales/team/[id]/outlets | MOCK | hardcoded outlets |
| sales/wallet | MOCK | same mock wallet data as partner |
| sales/kyc/[id]/ledger | NOT STARTED | shell |
| sales/team/[id] | NOT STARTED | shell |

---

## Gifsy Internal Pages

| Page | Status | Notes |
|------|--------|-------|
| gifsy/outlet-types | DONE | API wired |
| gifsy/users | DONE | GET /api/admin/users |
| gifsy/* (6 pages) | NOT STARTED | internal admin, low priority |

---

## Key Mock Data Sources to Replace

| File | What it contains | Used by |
|------|-----------------|---------|
| `src/lib/targets.ts` | OUTLET_ACHIEVEMENTS, SEED_CONFIGS, MOCK_OUTLETS, DEFAULT_PARAMS | partner/dashboard, partner/targets, admin/targets, admin/sales |
| `src/lib/outlet-data.ts` | SEED_DATA with hardcoded outlet prefill | KYC forms |
| `src/app/admin/dashboard/page.tsx` | getKpiCards(), growthMetrics, schemeData, payoutSummary, territoryData | Self-contained |
| `src/app/admin/kyc/page.tsx` | ALL_KYC (12 hardcoded entries) | Self-contained |
| `src/app/partner/wallet/page.tsx` | MOCK_BALANCE, MOCK_TRANSACTIONS, MOCK_INR_PAYOUTS | Self-contained |

---

## Execution Order (agreed with user)
1. **Partner pages** — in progress (current session)
2. **Sales pages** — after partner done
3. **Admin pages** — admin/dashboard is biggest, do last

---

## API Response Shape Reference
All API routes return: `{ success: boolean, data?: T, error?: string }`

Key shapes:
- GET /api/wallet → `{ earnedPoints, lockedPoints, redeemablePoints, redeemedPoints, expiredPoints, availablePoints }`
- GET /api/wallet/transactions → `{ transactions: WalletTransaction[] }`
- GET /api/partner/targets → `{ targets: [{ id, schemeId, schemeName, period, targetValue, achievedValue, percentage, status }] }`
- GET /api/leaderboard → check route file for shape
- GET /api/auth/me → `{ user: { id, name, mobile, role }, partner: {...} }`

---

## Architecture Notes
- No React Query or SWR — raw fetch() throughout
- Auth: JWT in localStorage key 'token', sent as Authorization: Bearer header
- Central client: `src/lib/api-client.ts` — use `api.get/post/put/del/patch`
- Tenant: resolved from Host/X-Forwarded-Host in proxy.ts (middleware)
- Tests: vitest, test files in `__tests__/` subdirs or `.test.ts` alongside file
