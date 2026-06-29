# Runbook — Production data load (#76)

> Create the Deoleo tenant's master data in the **live** `gifsy_prod` database via the
> **APP** (API endpoints + admin bulk-upload screens), because the Prisma seed is
> **firewalled OFF in production**. This is a CUTOVER-PHASE step: run it after the prod
> schema is current and before owner go-live UAT.
>
> Companion runbooks: schema must be current first → [`PROD-DB-MIGRATION.md`](PROD-DB-MIGRATION.md);
> empty-prod prep → [`PROD-DATA-WIPE.md`](PROD-DATA-WIPE.md). Per-tenant launch config →
> [`DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md`](DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md).

---

## 0. Pre-conditions (do these first)

1. **Prod schema is current.** Run the migration runbook ([`PROD-DB-MIGRATION.md`](PROD-DB-MIGRATION.md))
   so `gifsy_prod` is on the current baseline. The data-load below assumes every table
   (Client, OutletType, OutletTypeClientConfig, User, SalesUser, Outlet, CreditField, …) exists.
2. **Prod is the live cutover target.** `develop → main` merge is the deploy that ships current
   code to prod (`gifsy-api` / `gifsy-frontend`). The data load runs against that live app.
3. **The seed will NOT help you here.** `api/prisma/seed.ts` HARD-REFUSES unless
   `current_database()` is `gifsy_dev` or `gifsy_staging` (`api/prisma/seed.ts:111-118`,
   `allowed = ['gifsy_dev','gifsy_staging']`). It is the reference for *what* master data
   looks like, but it cannot create it in prod.

> ### ⚠️ BOOTSTRAP GAP — two rows have NO production app/API path (resolve before anything else)
> The following are created **only by the seed**, and there is no API endpoint or admin screen
> to create them. They must be inserted into `gifsy_prod` by a **one-time bootstrap** (a small
> load-script run inside the VPC, mirroring the seed, OR a manual SQL insert), because every step
> below depends on them:
>
> | Bootstrap row | Why it has no app path | Source of truth (seed) |
> |---|---|---|
> | **First `GIFSY_ADMIN` user** | No "create platform super-admin" endpoint exists. The admin users endpoint (`POST /v1/admin/users`) requires an *already-authenticated* admin, and `assertRoleAssignable` lets **only a GIFSY_ADMIN mint another GIFSY_ADMIN or a CLIENT_ADMIN** (`api/src/admin-core/admin-core.service.ts:53-78`). So you cannot bootstrap the first admin through the app. | `api/prisma/seed.ts:132-160` — `clientId='gifsy'`, `role=GIFSY_ADMIN`, `status=ACTIVE`, phone from `GIFSY_ADMIN_PHONE` (seed default `9830011252`). |
> | **`OutletType` master rows** (`WHOLESALER`, `SSS`, `SSS_TOT`, `SUB_STOCKIST`) | No OutletType-create endpoint anywhere (`api/src/kyc`, `api/src/gifsy`, `api/src/admin-*` checked). `GifsyService.createClient` only **iterates existing** `OutletType` rows to provision per-tenant configs (`api/src/gifsy/gifsy.service.ts:74-90`); it does not create the master rows. | `api/prisma/seed.ts` `OUTLET_TYPES` (the 4 codes above) — these are **global**, not per-tenant. |
>
> **Action:** before Step 1, run a bootstrap that inserts (a) the GIFSY_ADMIN user under the
> `gifsy` client and (b) the 4 OutletType master rows, by extracting just those inserts from
> `seed.ts` into a prod-safe load-script run inside the VPC (the DB is private-IP, like the
> migrate job). Verify GIFSY_ADMIN can OTP-login to prod and that `GET /v1/admin/credits/outlet-types`
> (once a tenant exists) returns the 4 codes.

---

## Dependency graph (ordered)

Each step needs everything above it to exist. **Bold = bulk upload** (file → screen);
the rest are one-by-one (API/admin form).

```
0.  Prod schema current (migration runbook)
0a. BOOTSTRAP (seed-only, no app path): GIFSY_ADMIN user  +  OutletType master rows (4 codes)
        │
1.  Client / tenant row  ── POST /v1/gifsy/clients  (GIFSY_ADMIN)
        │  └─ auto-provisions OutletTypeClientConfig for every active OutletType
2.  First CLIENT_ADMIN for Deoleo  ── POST /v1/admin/users  (GIFSY_ADMIN)
        │
3.  Per-tenant launch config  ── see DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md
        │     (conversion rate, visibility OFF, programs/categories, channels,
        │      credit caps/cutoff/notify, salesApp.upiEnabled, credit-field award maps)
        │
4.  SALES HIERARCHY  ── PUT /v1/admin/hierarchy-config  (whole chain in one snapshot)   ◀ BULK
        │     creates SalesHierarchyLevel + sales User + SalesUser rows
5.  Sales users (one-off additions)  ── POST /v1/admin/users  (optional; hierarchy upload is the bulk path)
        │
6.  OUTLETS (Outlet Master)  ── POST /v1/admin/outlets/upsert  (≤500 rows/batch; FE auto-chunks)  ◀ BULK
        │     each row references a valid OutletType code + a leaf-level (XSR) employee ID from step 4
        │
7.  KYC  ── happens LATER, in-app (sales reps via POST /v1/kyc → approval chain).
           NOT part of the bulk data load.
```

---

## Step 1 — Create the Deoleo Client (tenant)

- **Method:** API `POST /v1/gifsy/clients` (GIFSY_ADMIN only).
  Controller `api/src/gifsy/gifsy.controller.ts:26-31`; service `api/src/gifsy/gifsy.service.ts:97-165`.
  FE operator console (clients list / create) lives under `platform/src/app/gifsy/**`.
- **Inputs (CreateClientDto, `api/src/gifsy/dto/gifsy.dto.ts`):** `slug` (becomes the Client PK /
  tenant id — use `deoleo`), `internalName`, optional `status` (defaults `ONBOARDING`),
  `displayName`, `primaryColor`, `supportEmail`, `supportPhone`, `invoicePrefix`, `features`.
- **Side effect:** in the same transaction, `provisionOutletTypeConfigs` upserts an
  `OutletTypeClientConfig` row for **every active `OutletType`** with all-default flags
  (`gifsy.service.ts:74-90`, `DEFAULT_FLAGS` at :23-33). This is why the OutletType master
  rows (Step 0a) must exist FIRST — a tenant created before the master rows exist would get
  zero outlet-type configs and outlet upload would reject every row ("no outlet types enabled").
- **Verify:** `GET /v1/gifsy/clients/deoleo` returns the tenant;
  `GET /v1/admin/credits/outlet-types` (as a Deoleo-context admin) returns the 4 enabled codes.
- **Idempotency:** duplicate slug → 409 (`gifsy.service.ts:100-103,138-140`).

## Step 2 — Create the first CLIENT_ADMIN for Deoleo

- **Method:** API `POST /v1/admin/users` as **GIFSY_ADMIN** (in Deoleo tenant context).
  Controller `api/src/admin-core/users.controller.ts:30-33`; FE admin Users screen under
  `platform/src/app/admin/users/**`.
- **Inputs (CreateUserDto, `api/src/admin-core/dto/users.dto.ts:20-34`):** `phone` (exactly 10
  digits), `name`, `role` (`UserRole` enum), optional `email`.
- **Why GIFSY_ADMIN must do this:** `assertRoleAssignable` only lets a GIFSY_ADMIN assign
  `CLIENT_ADMIN` (`admin-core.service.ts:53-78`). A CLIENT_ADMIN can only assign the
  tenant-operational roles (MIS_USER, the SALES_* roles, SSS/WHOLESALER/SUB_STOCKIST).
- **Verify:** the CLIENT_ADMIN can OTP-login to prod and load `/admin`.
- After this, the CLIENT_ADMIN (or GIFSY_ADMIN) can drive Steps 3–6.

## Step 3 — Per-tenant launch configuration

Do the full checklist in [`DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md`](DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md)
**before** the credit upload and (for programs/categories) **before** the outlet upload.
The single most load-blocking item:

- **Credit-field award maps** (`outletTypeAwards`) are **EMPTY on field creation**
  (`api/src/credits/credits.service.ts:585-608`, DTO default `{}`). An unmapped outlet type is
  treated as **NA → the credit row is silently skipped**. Set every credit field's per-outlet-type
  map (WHOLESALER=POINTS, all other types=PAYOUT) via `PATCH /v1/admin/credits/fields/:id`
  (`credits.service.ts:617-655`) in **Admin → Credits & Payouts → Field Configuration**
  (`platform/src/app/admin/credits-payouts/fields/page.tsx`) before the first credit upload.
- **Outlet programs/categories** (`outletPrograms`/`outletCategories`) must contain Deoleo's
  real program/category values — the outlet-master parser rejects any `Program Name` /
  `Program Category` not in the tenant's lists (defaults are the old hardcoded values, which may
  not match Deoleo). Set them in **Admin → Settings** (the "Outlet Programs & Categories" card)
  first.

## Step 4 — Sales hierarchy (BULK, one snapshot)

- **Method:** API `PUT /v1/admin/hierarchy-config` (GIFSY_ADMIN or CLIENT_ADMIN).
  Controller `api/src/admin-core/hierarchy-config.controller.ts:43-47`; FE screen `/admin/hierarchy`
  (`platform/src/app/admin/hierarchy/page.tsx`); the 18-column chain parser is
  `platform/src/lib/employee-hierarchy.ts` (`parseHierarchyChainRows`).
- **Inputs:** a JSON body `{ employees: [...] }` — the FE parses the uploaded xlsx (the 18-column
  denormalized chain, see the template spec in the checklist), validates it, and POSTs the
  employee array. The PUT reads the **raw Express body** on purpose (a method note explains the
  global ValidationPipe would mangle the untyped employee objects — see the controller comment).
- **Side effect:** persists the authoritative relational tree — `SalesHierarchyLevel` rows + a
  `User` + `SalesUser` per employee.
- **Gotchas:** body parser raised to **25 MB** (`main.ts`) so large files don't 413; the FE chunks
  large files; numeric ID/phone cells are coerced to strings. Employee IDs may contain any
  character (the format rule was removed). Phones must be exactly 10 digits if present.
- **Verify:** `GET /v1/admin/hierarchy-config` returns the snapshot; a sales user can OTP-login and
  sees their downline.

## Step 5 — Sales users (one-off additions only)

- The hierarchy upload (Step 4) is the **bulk** path that creates all sales users. Use
  `POST /v1/admin/users` (Step 2 mechanics) only for ad-hoc additions after the chain is loaded.
- A CLIENT_ADMIN may assign the SALES_* roles (and MIS_USER, partner roles); only a GIFSY_ADMIN
  may assign CLIENT_ADMIN/GIFSY_ADMIN (`admin-core.service.ts:53-78`).

## Step 6 — Outlets (Outlet Master, BULK)

- **Method:** API `POST /v1/admin/outlets/upsert` (≤500 rows/request; the FE auto-chunks a big file
  into ≤500 batches). Controller `api/src/admin-outlets/admin-outlets.controller.ts:32-37`;
  DTO `UpsertOutletsDto` (`api/src/admin-outlets/dto/admin-outlets.dto.ts:78-85`, ArrayMaxSize 500);
  FE screen `/admin/users/outlets` (`platform/src/app/admin/users/outlets/page.tsx`); the 13-column
  parser is `platform/src/lib/outlet-upload.ts` (`OUTLET_UPLOAD_HEADERS`).
- **Inputs:** the 13-column Outlet Master file (see template spec in the checklist). Each row's
  `Outlet Type` must be one of the 4 tenant-enabled codes; each `XSR ID` must be an existing
  **leaf-level (XSR)** employee from Step 4; each `Program Name`/`Program Category` must be in the
  tenant's lists (Step 3).
- **Write-time invariants (backend):** OutletType resolved by code, XSR resolved by employeeCode,
  outlet keyed on `clientId_outletCode`. New outlets are created `isActive=false` (PENDING) until
  KYC approval.
- **Verify:** `GET /v1/admin/outlets` lists them; the upload returns a per-row summary
  (created/updated/reactivated + per-row errors); a failed batch downloads a full-file error report
  with a Remarks column.

## Step 7 — KYC (later, in-app — NOT part of the data load)

- KYC is a runtime flow, after outlets exist. Sales reps submit per-outlet KYC via `POST /v1/kyc`
  (`api/src/kyc/kyc.controller.ts:84`), then the field-chain → Gifsy approval chain runs in-app.
- A partner **Wallet is created only at KYC approval** (or get-or-create at credit time). Points can
  accrue to a pre-KYC outlet, but redemption (all modes) is gated on KYC-APPROVED + active.
- Do not attempt to bulk-load KYC as master data; it is operational, not provisioning.

---

## Bulk-upload vs one-by-one summary

| Step | Data | Method | Bulk? |
|---|---|---|---|
| 0a | GIFSY_ADMIN + OutletType master | one-time bootstrap load-script (seed-only, no app path) | n/a |
| 1 | Client / tenant | `POST /v1/gifsy/clients` | one |
| 2 | First CLIENT_ADMIN | `POST /v1/admin/users` | one |
| 3 | Tenant config | Settings/credits screens (see checklist) | one each |
| 4 | Sales hierarchy | `PUT /v1/admin/hierarchy-config` | **BULK** (one snapshot) |
| 5 | Extra sales users | `POST /v1/admin/users` | one |
| 6 | Outlets | `POST /v1/admin/outlets/upsert` | **BULK** (≤500/batch, FE auto-chunks) |
| 7 | KYC | `POST /v1/kyc` (in-app, later) | operational, not load |
