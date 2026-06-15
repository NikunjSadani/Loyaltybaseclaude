# Phase 2 — §05 API Surface

All API routes (`src/app/api/`), grouped by bounded context. **Methods are verified** from the
handler exports (~113 handlers). Roles are best-known from handler checks; "scoped" = results
filtered by ownership/hierarchy. All routes are tenant-scoped via `clientId`.

## 1 · Identity & Auth

> **✅ P1:** `getAuthUser` is now session-validated — it looks up the `UserSession` row on every
> request (revocable; 365-day sliding idle) and enforces subdomain==session-tenant for non-Gifsy
> callers (GIFSY_ADMIN exempt). All 44 admin route files have `requirePermission` wired (additive,
> **flag-gated off by default** via `RBAC_ENFORCEMENT` env + per-tenant `features.rbacEnforcement`).

| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| POST | `/auth/send-otp` | Send login OTP | public |
| POST | `/auth/verify-otp` | Verify OTP → JWT + create `UserSession` | public |
| GET | `/auth/me` | Current user | any auth |
| POST | `/auth/logout` | Revoke current session + clear token cookie | any auth |
| POST | `/auth/logout-all` | Revoke all sessions for the calling user | any auth |
| GET | `/admin/users` | List users | admin |
| POST | `/admin/users` | Create user | admin |
| GET·PATCH·DELETE | `/admin/users/[id]` | User detail / update (edit-phone revokes sessions) / delete | admin |
| POST | `/admin/users/bulk-edit` | Bulk user edits | admin |
| POST | `/admin/force-logout-all` | Global kill switch — revoke every session (all tenants) | GIFSY_ADMIN only |
| GET | `/admin/settings/config` | Read tenant config from DB (Client row) | admin |

## 2 · Tenancy & Platform Config
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET | `/gifsy/clients` | List tenants (registry) | GIFSY_ADMIN |
| GET | `/gifsy/clients/[slug]/outlet-type-configs` | Tenant outlet-type config | GIFSY_ADMIN |
| PUT | `/gifsy/clients/[slug]/outlet-type-configs/[code]` | Upsert outlet-type config | GIFSY_ADMIN |
| GET·PUT | `/admin/settings` | Tenant settings | admin |
| GET·POST | `/admin/skus` | SKU catalog | admin |
| GET·POST | `/admin/tiers` | Tier config | admin |
| GET·PUT | `/admin/task-config` | Sales task config | admin |

## 3 · Sales Org & Team
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET·PUT | `/admin/hierarchy-config` | Employee hierarchy (blob) | admin |
| GET | `/sales/team` | My team | sales (scoped) |
| GET | `/sales/team/[memberId]` | Member detail | sales (scoped) |
| GET | `/sales/team/[memberId]/outlets` | Member's outlets | sales (scoped) |

## 4 · Partners & Outlets
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET | `/admin/channel-partners` | List partners | admin |
| GET·PATCH | `/admin/channel-partners/[id]` | Partner detail / update | admin |
| GET | `/admin/outlets` | Outlet list (JSON) | admin |
| POST | `/admin/outlets/upsert` | Bulk create/update outlets | admin |
| POST | `/admin/outlets/deactivate` · `/reactivate` · `/bulk-delete` | Outlet state ops | admin |
| POST | `/admin/outlets/rekyc-flag` | Flag outlets for re-KYC | admin |
| GET | `/admin/reports/outlet-master` | Outlet master export (xlsx) | admin |
| GET | `/sales/outlets` | My outlets | sales (scoped) |

## 5 · KYC & Enrollment
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| POST·GET | `/kyc` | Create / list submissions | sales · admin |
| GET·PATCH | `/kyc/[id]` | Detail / admin status set | scoped · GIFSY (PATCH) |
| POST | `/kyc/[id]/first-approve` | Reporting-manager approval | SO/ASM/RSM |
| POST | `/kyc/[id]/approve` | Final approval | GIFSY_ADMIN |
| POST | `/kyc/[id]/reject` | Reject (field-level reason) | approver · GIFSY |
| GET | `/kyc/[id]/ledger` | KYC history | scoped |
| POST | `/kyc/consent` | Capture consent | partner |
| POST | `/kyc/not-interested` | Mark outlet not interested | sales |
| GET | `/kyc/sla-metrics` | KYC SLA metrics | admin |

## 6 · Schemes & Activations
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET·POST | `/schemes` | List / create | admin · scoped read |
| GET·PATCH·DELETE | `/schemes/[id]` | Detail / update / delete | admin |
| GET | `/schemes/[id]/targets` · `/schemes/targets` | Scheme targets | scoped |
| POST | `/schemes/calculate` | Reward calc (aspirational, Gap #10) | — |
| GET | `/admin/schemes/[id]/enrollments/export` | Enrollment export | admin |

## 7 · Targets & Achievements
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET·PUT | `/admin/target-config` | Target configs (blob) | admin |
| DELETE | `/admin/target-config/[id]` | Delete config | admin |
| GET·PUT | `/admin/kpi-config` | KPI defs | admin |
| POST | `/admin/sales/bulk-upload` | Achievement upload | admin |
| GET | `/admin/sales/batches` · `/admin/sales/records` | Upload batches / records | admin |
| DELETE | `/admin/sales/batches/[batchId]` | Delete batch | admin |
| POST | `/sales/upload` · GET `/sales/last-upload` | Field sales upload | sales |
| GET | `/partner/targets` | My targets vs achievement | partner |

## 8 · Wallet & Points
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET | `/wallet` | Wallet balance | partner |
| GET | `/wallet/transactions` | Ledger | partner |
| POST | `/wallet/adjust` | Manual adjustment | admin |

## 9 · Rewards & Redemption
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET | `/rewards/catalog` · `/rewards/catalog/[id]` | Catalogue | partner |
| GET | `/rewards/orders` · `/rewards/orders/[id]` | Orders | partner (scoped) |
| PATCH | `/rewards/orders/[id]` | Order status update | admin/fulfilment |
| POST | `/rewards/redeem` | Place order | partner |
| POST | `/rewards/redeem/confirm` | OTP confirm → debit points | partner |
| GET·PUT | `/admin/gift-config` | Gift catalogue config | admin/GIFSY |

## 10 · Visibility
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| POST | `/visibility/submit` | Submit photos (mode A) | partner/sales |
| GET | `/visibility/submissions` | List submissions | scoped |
| POST | `/visibility/submissions/[id]/approve` · `/reject` | Review | admin/reviewer |
| GET | `/visibility/outlet-statuses` · `/visibility/fraud-log` | Statuses / fraud | admin |
| POST | `/admin/visibility/bulk-upload` | Visibility upload (mode B) | admin |
| GET | `/admin/visibility/records` | Visibility records | admin |

## 11 · Finance — Credits *(award path)*
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET·POST | `/admin/credits/fields` · PATCH `/fields/[id]` | Credit parameters (headers) | admin |
| GET·POST | `/admin/credits/batches` | Upload / list batches | admin |
| GET | `/admin/credits/batches/[id]` | Batch detail | admin |
| POST | `/admin/credits/batches/[id]/confirm` | Confirm batch | admin/GIFSY |
| GET·POST | `/admin/credits/batches/[id]/reversals` | Reversals | admin/GIFSY |
| GET | `/admin/credits/eligible-outlets` | Eligible outlets | admin |
| GET·POST | `/admin/credits/payout-downloads` | Bank download files | GIFSY |
| POST | `/admin/credits/payout-downloads/[id]/utr` | Upload UTRs | GIFSY_ADMIN |
| GET | `/admin/credits/reversals` · PATCH `/reversals/[id]` | Reversal approval | GIFSY |

## 12 · Finance — Payouts & Fund *(redemption path)*
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET·POST | `/payouts/batches` · GET `/batches/[id]` | Payout batches | admin/GIFSY |
| POST | `/payouts/batches/[id]/process` | Process batch | GIFSY |
| GET | `/payouts/fund` · POST `/fund/receive` | Client float / receipts | admin/GIFSY |
| GET | `/payouts/reconciliation` · `/payouts/transactions` | Recon / txns | admin |
| GET | `/partner/payouts` | My payouts | partner |

## 13 · Finance — Invoices
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET·POST | `/admin/invoices` · `/admin/invoices/upload` | Invoice mgmt | admin/GIFSY |
| GET | `/partner/invoices` · `/partner/invoices/[id]` | View invoice | partner |
| PATCH | `/partner/invoices/[id]` | **Edit invoice number** (Gap #8) | partner |
| GET | `/sales/invoices` · `/sales/invoices/[id]` | Sales view | sales (scoped) |

## 14 · Engagement
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET·PUT | `/admin/banner-config` | Banner config | admin |
| GET·POST·DELETE | `/admin/banners` | Banners | admin |
| GET | `/partner/banners` | Partner-app banners | partner |
| GET | `/leaderboard` · `/sales/leaderboard` | Rankings | scoped |

## 15 · Reporting & Analytics
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET | `/admin/dashboard/kpis` | Dashboard KPIs | admin |
| GET | `/reports/{billing-trends,engagement,kyc-status,payout-liability,scheme-performance,tds,visibility-status}` | Reports | admin/MIS |

## 16 · Support
| Method | Endpoint | Purpose | Role |
|---|---|---|---|
| GET·POST | `/tickets` | List / raise (self or on-behalf) | scoped |
| GET | `/tickets/[id]` | Ticket detail | scoped |
| POST | `/tickets/[id]/messages` | Add message | scoped |
| POST | `/tickets/[id]/escalate` | Escalate | scoped |

## Observations
- **No standard REST create for outlets** — only `upsert` (POST). Consistent with Excel-first ops.
- **`schemes/calculate`** exists but is the aspirational reward engine (Gap #10).
- **Config endpoints** (`*-config`) read/write `ProgramSetting` JSON blobs (Gap #18).
- **No public notification API** — notifications are internal (queue/templates).
- Sales/returns (`POST /sales/returns`) covers invoice returns (`InvoiceReturn`).
