# P2 Reconcile — Organization & Master Data

**Task 2.0.** Audit of the existing code for the three P2 bounded contexts (Sales Org · Partners/Outlets · Catalog) against the spec (`docs/spec/01-capabilities.md`, `03-data-model.md`, `02-workflows.md`) and gaps **#4** (Partner/Outlet 1:1) + **#11** (configurable hierarchy). Read-only — no code changed, no DB touched.

> **Rule:** plan against the spec, build against the code; where they disagree, **the code wins** and the spec note is a correction. Tags: **BUILD** (missing) · **COMPLETE** (partial/stub/DEMO-only — finish it) · **VERIFY** (looks done — prove with a test).

**Method / audit.** A Sonnet reconnaissance wave produced the first pass; the orchestrator (Opus) then **independently re-read every load-bearing claim** — all four stub/IDOR routes, the two schema models, and the sales-upload writer — before recording them here. The security findings below are confirmed by direct file inspection, not relayed on the executor's word.

---

## Capability tags

| Context | Capability | Tag | Evidence | clientId-scoped? | Gap |
|---|---|---|---|---|---|
| Sales Org | Relational hierarchy model `SalesHierarchyLevel` | COMPLETE (exists, not wired to live flow) | `schema.prisma:532`; tenant `@@unique([clientId,code])`. ⚠️ `level Int @unique` (l.537) is **globally** unique | model: yes | #11 |
| Sales Org | Admin hierarchy config (upload/save) | COMPLETE (JSON-blob, not relational) | `api/admin/hierarchy-config/route.ts` reads/writes `ProgramSetting` key `employee_hierarchy`; does **not** touch `SalesUser`/`SalesHierarchyLevel` | yes | #11, #18 |
| Sales Org | Hierarchy upload validation engine | VERIFY (rich, pure) | `lib/employee-hierarchy.ts` — two-pass validation, 6-level XSR<SO<ASM<RSM<ZNM<NSM, circular-dep check, 18-col chain parser; **MOCK/localStorage-backed** | n/a (pure) | #11 |
| Sales Org | Sales-role derivation (legacy) | COMPLETE (mock) | `lib/sales-role.ts` — hardcoded `SalesRole` union, `ROLE_PHONES`, localStorage `getRole()` | no | #11, #9 |
| Sales Org | Sales team self-view (`/sales/team`) | VERIFY | `api/sales/team/route.ts` — relational `SalesUser`+`subordinates`, real DB | ⚠️ see RED FLAGS | #11 |
| Sales Org | Sales team drill-down (`/sales/team/[memberId]`, `/outlets`) | COMPLETE (insecure) | both routes `findFirst({id:memberId,deletedAt:null})` | ❌ **no clientId, no ownership** | #11 |
| Partners/Outlets | Partner+Outlet model | VERIFY | `ChannelPartner` `schema:642`; `Outlet` `schema:895`; `partnerId` required **non-unique** ⇒ 1:many + `isPrimary` | denormalized `clientId` on partner | #4 |
| Partners/Outlets | Outlet master upload (parse) | VERIFY (pure) | `lib/outlet-upload.ts` — add/update/reactivate/re-KYC/deactivate validation + templates | n/a | #4 |
| Partners/Outlets | Outlet **upsert (write)** | **BUILD** (stub) | `api/admin/outlets/upsert/route.ts` — **no DB write**; `getClientIdFromRequest` called + discarded (l.18); returns `upserted: rows.length` in both branches | n/a (no query) | #4 |
| Partners/Outlets | Outlet **re-KYC flag (write)** | **BUILD** (stub) | `api/admin/outlets/rekyc-flag/route.ts` — same no-op pattern; uses perm `kyc:initiate`; **no storage field exists** for the flag | n/a | — |
| Partners/Outlets | Outlet list (admin) | VERIFY | `api/admin/outlets/route.ts` real query; some display fields hardcoded | ✅ `partner:{user:{clientId}}` | #4 |
| Partners/Outlets | Deactivate / Reactivate / Bulk-delete | VERIFY (real) | three routes, real writes | ✅ `partner:{user:{clientId}}` | — |
| Partners/Outlets | Outlet master export | VERIFY | `lib/outlet-master-export.ts` — 9-section, 58-col xlsx; `DEMO_*` default | caller supplies rows | — |
| Partners/Outlets | Partner session | COMPLETE (mock) | `lib/partner-session.ts` — client, `DEMO_SESSIONS`, localStorage | no | — |
| Partners/Outlets | **Distributor entity** | **BUILD (net-new)** | no `Distributor` model anywhere; only free-text `distributorCode/Name` on `SalesInvoice` (`schema:1074`) + reference-only cols in outlet upload/export | — | (R1) |
| Catalog | SKU model + CRUD | VERIFY | `Sku` `schema:985`; `api/admin/skus` GET (paged, scoped) + POST (zod, dup-check) | ✅ `{clientId}` | — |
| Catalog | Category | COMPLETE (model only) | `Category` self-ref tree `schema:961` + `SkuCategoryMapping`; **no CRUD route** | model scoped | — |
| Catalog | Tiers / classes | VERIFY | `TierConfig` `schema:619`; `api/admin/tiers` GET+POST; verifies class∈client | ✅ via `partnerClass:{clientId}` | — |
| Catalog | Tiers/SKUs/Catalog **admin UI** | **BUILD** | no `admin/{tiers,skus,catalog}` page dirs — API-only | — | — |

---

## Targeted answers (the drivers for 2.1–2.6)

1. **Hierarchy (#11/#18).** Relational `SalesHierarchyLevel` + `SalesUser.reportingToId` tree EXIST and back `/sales/team`, but the **live admin upload writes a JSON blob** into `ProgramSetting.employee_hierarchy` — it does NOT populate the relational tables. So there are two parallel sources of truth. The `UserRole` enum still hardcodes 5 sales rungs (`SALES_HO/STATE_HEAD/ASM/SO/ISR`) with **no ZNM**, while the lib + relational model use the 6-rung `XSR<SO<ASM<RSM<ZNM<NSM` ladder. Role derivation: demo path = `sales-role.ts` localStorage; real path = `SalesUser.hierarchyLevel.code`.

2. **1:1 binding (#4).** Schema is **1:many** (`Outlet.partnerId` non-unique, `isPrimary` flag only). Login/wallet/KYC bind to **Partner** (`ChannelPartner.userId @unique`); visibility/geo bind to **Outlet**. The 1:1 operating convention is **not enforced** — no unique constraint.

3. **Distributor.** **Absent — net-new.** Required for the R1 Outlet Points Ledger outlet→distributor columns + 1:1 points attribution.

4. **Outlet master upload.** `lib/outlet-upload.ts` is a real pure parser/validator; the `upsert` wiring route is a **no-op stub** (parses nothing into the DB). Deactivate/reactivate/bulk-delete ARE real and scoped.

5. **Catalog.** SKUs + Tiers are real and clientId-scoped (API-only). Missing: Category CRUD route, SkuCategoryMapping write, and all admin UI.

6. **Sales team scoping.** Self-view (`/sales/team`) returns the caller's own subordinates. Drill-down (`/sales/team/[memberId]` + `/outlets`) looks up by raw `memberId` with **no clientId filter and no subordinate-ownership check** → cross-tenant IDOR.

---

## 🚩 RED FLAGS (tenant-isolation / correctness — confirmed by direct read)

> **RF1–RF3 FIXED in Wave 1** (commit pending) — gated by Opus (tsc 0, new pure test 10/10, no new lint/test reds). New helper `lib/sales-hierarchy-access.ts:isSelfOrDescendant` + `lib/__tests__/sales-hierarchy-access.test.ts`. RF4/RF5 remain (they're migrations → 2.1/2.4).

| # | Severity | Where | Issue | Status |
|---|---|---|---|---|
| RF1 | **High** | `api/sales/team/[memberId]/route.ts:22`, `…/[memberId]/outlets/route.ts:22` | No `clientId` filter and no subordinate-ownership check on `memberId` → any authenticated user can read **any** sales member's team + outlets across tenants (IDOR + cross-tenant leak). | ✅ FIXED — `user:{clientId}` scope + `isSelfOrDescendant` ownership gate (fails closed → 403) |
| RF2 | **High** | `api/sales/upload/route.ts:62` | Invoice dup pre-check `findMany({where:{invoiceNumber:{in:…}}})` is **not clientId-scoped** → leaks other tenants' invoice numbers and false-positives on cross-tenant dups (table is `@@unique([clientId,invoiceNumber])`). | ✅ FIXED — `clientId` added to `where` |
| RF3 | **Med-High** | `api/sales/upload/route.ts:131` | Writes `partnerId: authUser.userId` — a **User id into a ChannelPartner FK** → data-integrity bug (every uploaded invoice mis-attributed). | ✅ FIXED — `partnerId` derived from outlet→partner map |
| RF4 | **Med** | `prisma/schema.prisma:537` | `SalesHierarchyLevel.level Int @unique` is **globally** unique → two tenants cannot both define a level-1. Should be `@@unique([clientId, level])`. |
| RF5 | **Med** | `prisma/schema.prisma:899` | `Outlet.outletCode @unique` is **globally** unique → conflicts with the P2 modeling note that one physical outlet may exist as separate per-tenant records. Should likely be `@@unique([clientId, outletCode])` (via partner→client). |
| RF6 | **Low** | `outlets/upsert`, `outlets/rekyc-flag` | Discard `getClientIdFromRequest` and write nothing, yet return `{upserted/flagged: N}` success → silent no-op that masks data loss in the UI. |

> RBAC enforcement is OFF and `DEMO_MODE` injects identity, so RF1/RF2 are not exploitable in the current demo — but they are real production defects and must be closed in P2.2 before any real-tenant traffic.

---

## Net-new BUILD shortlist

1. **`Distributor` model** + `Outlet.distributorId` FK (net-new; unblocks R1 ledger).
2. **Wire `outlets/upsert`** → real clientId-scoped create/update from the parsed rows.
3. **Wire `outlets/rekyc-flag`** → add a storage field (on `Outlet`) + persist.
4. **Hierarchy source-of-truth reconcile (#11/#18):** admin upload writes relational `SalesUser`/`SalesHierarchyLevel` (with the ZNM rung), not only the JSON blob.
5. **Category CRUD** route + `SkuCategoryMapping` writes.
6. **Admin UI** for tiers / SKUs / categories.
7. Replace mock `sales-role.ts` / `MOCK_EMPLOYEES` with DB-backed derivation.

---

## Refined P2 task breakdown (against real file targets)

| Task | Scope | Tag mix | DB/migration? |
|---|---|---|---|
| **2.1** Hierarchy | Reconcile the JSON-blob vs relational source of truth (#11/#18); wire admin upload → relational tree; add ZNM rung; **fix RF4** (`@@unique([clientId,level])`) | COMPLETE + VERIFY | ⚠️ migration (additive + constraint) |
| **2.2** Sales user CRUD + assignment | Verify CRUD; **fix RF1** (scope+ownership on drill-down), **RF2/RF3** (scope dup-check, correct partner FK) | VERIFY + bug-fix | no |
| **2.3** Partner classes + tiers | Verify `tiers`; add tier-history if missing | VERIFY | maybe |
| **2.4** Partner+Outlet + Distributor | Finalize 1:1 binding decision (#4); **define `Distributor` entity + `Outlet.distributorId`**; **wire `outlets/upsert` + `rekyc-flag`**; consider RF5 (`outletCode` per-tenant) | BUILD + COMPLETE | ⚠️ **migration — human gate** |
| **2.5** Outlet management UI | Verify search/filter/deactivate/re-KYC flows end-to-end | VERIFY | no |
| **2.6** Catalog | Category CRUD route + mapping writes; tiers/SKUs/category admin UI | BUILD | no |

**Escalations to the owner before build:**
- **2.4 schema** — the 1:1-binding decision (enforce unique `partnerId`, or keep 1:many + `isPrimary`?) and the new `Distributor` shape both define an **additive dev-DB migration**. Needs sign-off + the exact diff-SQL shown before apply (per DEV-DB.md; `current_database()='gifsy_dev'` guard; never `migrate dev`).
- **2.1 migration** — the `level` unique-constraint fix (RF4) is also a migration.
- **Security** — RF1/RF2/RF3 are pre-existing prod defects surfaced by this reconcile; recommend folding their fixes into 2.1/2.2 rather than deferring.
