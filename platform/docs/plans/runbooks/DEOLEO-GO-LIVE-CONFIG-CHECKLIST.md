# Deoleo go-live config checklist + client data templates

> Every per-tenant setting to configure for **Deoleo** at launch, plus the exact
> column lists Deoleo must fill for the three client-supplied data files.
> Provisioning order: [`PROD-DATA-LOAD.md`](PROD-DATA-LOAD.md).
>
> All per-tenant settings are stored in `program_settings` (keyed by `clientId`) and
> typed/defaulted by `api/src/tenant/tenant-settings.service.ts`. Unless noted, they are
> written via `PUT /v1/admin/settings` (`UpsertSettingDto {key,value}`,
> `api/src/admin-core/settings.controller.ts:30-35`) and **GIFSY_ADMIN-gated**.

---

## A. Per-tenant settings checklist

| ✓ | Setting (key) | Where (UI path / endpoint) | Value for Deoleo | Default | Why it matters |
|---|---|---|---|---|---|
| ☐ | **Credit-field award maps** (`outletTypeAwards` per field) | Admin → Credits & Payouts → **Field Configuration** (`/admin/credits-payouts/fields`) → per-field POINTS/PAYOUT/NA editor. Create: `POST /v1/admin/credits/fields`; set map: `PATCH /v1/admin/credits/fields/:id` (`credits.service.ts:585-655`). | **For every credit field:** `WHOLESALER = POINTS`; `SSS = PAYOUT`, `SSS_TOT = PAYOUT`, `SUB_STOCKIST = PAYOUT`. | `{}` **EMPTY on creation** → every type treated as **NA → row silently skipped**. | **Hard blocker for credit upload.** Until the map is set per field, every credit upload silently skips all rows. Outlet types are read **dynamically** from the tenant (`GET /v1/admin/credits/outlet-types`). |
| ☐ | **Conversion rate** (`conversionRate`, POINTS→INR) | `PUT /v1/admin/settings` key `conversionRate` (GIFSY-operated). Default source `POINTS_CONVERSION_RATE` env; typed in `tenant-settings.service.ts`. | Set to Deoleo's agreed POINTS→INR rate (owner to confirm the number). | `1` (env fallback); must be **≥ 0.005**, `> 0`. | Redemption value = points ÷ conversionRate; the rate is **frozen onto each order**. A wrong/zero rate misprices every redemption and payout. |
| ☐ | **Visibility master switch** (`visibilityEnabled`) | Admin → **Settings** (`/admin/settings`, "Visibility Module" ON/OFF card, GIFSY-only). `PUT /v1/admin/settings` key `visibilityEnabled`. | **OFF** (owner decision 2026-06-25). | `false` (opt-in). | When OFF, all 8 visibility endpoints 403 for the tenant's users and all visibility surfaces hide. Read **uncached + fail-closed** so the flip is immediate. Deoleo launches OFF. |
| ☐ | **Outlet programs** (`outletPrograms`) | Admin → **Settings** → "Outlet Programs & Categories" card (chips, GIFSY-only). `PUT /v1/admin/settings` key `outletPrograms`. | Deoleo's **real** program names (owner to supply). | `['Trade Loyalty','Gold Programme']`. | The outlet-master parser **rejects** any `Program Name` not in this list. Must match the values in the outlet file **before** the outlet upload. |
| ☐ | **Outlet categories** (`outletCategories`) | Same card / `PUT /v1/admin/settings` key `outletCategories`. | Deoleo's **real** category values (owner to supply). | `['Premium','Standard','Economy']`. | Same as above for `Program Category`. |
| ☐ | **Redemption channels** (`redemptionChannels`) | `PUT /v1/admin/settings` key `redemptionChannels` (object). Enforced at redeem time. | Confirm which of physical gifts / vouchers / bank transfer Deoleo allows. | `{ physicalGifts:true, vouchers:true, bankTransfer:true }` (all on). | Gates which redemption modes partners may use. Leaving a disallowed channel on exposes an unwanted redemption path. |
| ☐ | **Credit caps / cutoff / notify** (`creditsPayouts`) | `PUT /v1/admin/settings` key `creditsPayouts` (object). Enforced in `credits.service.ts` at batch creation. | Confirm the month cutoff day + safety caps for Deoleo; set `notifyEmails` to Deoleo/Gifsy ops recipients. | `{ monthCutoffDay:28, safetyCapPoints:50000, safetyCapInr:100000, fourEyesEnabled:false, notifyEmails:[] }`. | Caps reject an over-large credit batch; the cutoff day enforces the upload window; empty `notifyEmails` falls back to `ops@gifsy.in`. (`fourEyesEnabled` is **not** enforced yet — maker-checker deferred.) |
| ☐ | **UPI on KYC form** (`salesApp.upiEnabled`) | Admin → **Settings** → "UPI Collection (KYC form)" ON/OFF card (GIFSY-only). `PUT /v1/admin/settings` key `salesApp` (whole object). | Confirm with owner — default **OFF** hides UPI on the KYC form (bank-only). | `false` (nested in `salesApp`, which also holds `ledgerLabel:'Wallet'`, `redeemGiftWholesalerOnly:true`). | When OFF, the KYC form collects bank only and forces `paymentMode='bank'`. FE-only gate; payouts unaffected. |

> **Notes on enforcement / gotchas**
> - `conversionRate`, `redemptionChannels`, `creditsPayouts` currently have **no dedicated admin
>   UI card** — set them via `PUT /v1/admin/settings` (the GIFSY operator path). `visibilityEnabled`,
>   `outletPrograms`/`outletCategories`, and `salesApp.upiEnabled` have admin Settings cards.
> - `salesApp` is written as a **whole object** — when toggling `upiEnabled`, send the full
>   `salesApp` object so the other keys aren't dropped (the admin card already does this).
> - Award values are strictly validated to `POINTS | PAYOUT | NA` on PATCH — a malformed map is
>   rejected (`credits.service.ts:617-655`), so money can't be misrouted by a typo.

---

## B. Client data templates (what Deoleo must fill)

Three files Deoleo supplies. Columns are taken **verbatim** from the parsers. Fill required
columns for every row; optional columns may be blank.

### (a) Sales hierarchy chain — 18 columns

- **Parser:** `platform/src/lib/employee-hierarchy.ts` (`parseHierarchyChainRows`,
  `getHierarchyChainHeaders`). Loaded on `/admin/hierarchy` → `PUT /v1/admin/hierarchy-config`.
- **Layout:** 3 columns (`ID`, `Name`, `Phone`) **per hierarchy level**, leaf-first. For Deoleo's
  6 levels (XSR → SO → ASM → RSM → ZNM → NSM) the **exact, ordered** headers are:

  ```
  XSR ID | XSR Name | XSR Phone
  SO ID  | SO Name  | SO Phone
  ASM ID | ASM Name | ASM Phone
  RSM ID | RSM Name | RSM Phone
  ZNM ID | ZNM Name | ZNM Phone
  NSM ID | NSM Name | NSM Phone
  ```

  (Generated from the tenant's hierarchy-level config; download the live template from the screen
  to get the exact header row — do not hand-type it.)

| Column group | Required? | Rules / gotchas |
|---|---|---|
| **All 6 `… ID` columns** | **Required** (every row, all 6) | A blank ID in any level → whole file rejected (`MISSING_ID`). |
| All 6 `… Name` columns | Optional | Same employee ID must not have conflicting names across rows. |
| All 6 `… Phone` columns | Optional | If present, **exactly 10 digits** (no +91, no spaces). Conflicting phones for one ID → reject. |

- **Gotchas:** one row per leaf (XSR); a manager may appear in any row. A leaf XSR ID must be
  **unique** across the file (duplicate → `DUPLICATE_XSR`). An ID can't appear in two level columns
  of the same row (`SELF_REFERENCE`). Employee IDs may contain **any character** (the format rule was
  removed — owner decision). Headers are exact-match (trimmed, not lowercased). Numeric-looking
  ID/phone cells are coerced to strings.

### (b) Outlet master — 13 columns

- **Parser:** `platform/src/lib/outlet-upload.ts` (`OUTLET_UPLOAD_HEADERS`,
  `validateOutletUpload`). Loaded on `/admin/users/outlets` → `POST /v1/admin/outlets/upsert`.
- **Exact, ordered headers:**

  ```
  Outlet ID | Outlet Name | Program Name | Program Category | Outlet Type |
  Beat | Distributor ID | Distributor Name | Metro | City | State | Zone | XSR ID
  ```

| Column | Required (new outlet)? | Rules / gotchas |
|---|---|---|
| **Outlet ID** | **Required** | Any character allowed (no format restriction). Must be unique within the file; keyed on `clientId_outletCode`. |
| **Outlet Name** | **Required** (new) | Ignored for existing outlets (can't be renamed via master upload). |
| **Program Name** | **Required** | Must be in the tenant's `outletPrograms` list (set it first — see §A). Case-sensitive exact match. |
| **Program Category** | **Required** | Must be in the tenant's `outletCategories` list. Case-sensitive. |
| **Outlet Type** | **Required** | Must be one of the **4 tenant-enabled codes**: `WHOLESALER`, `SSS`, `SSS_TOT`, `SUB_STOCKIST`. Compared uppercased. |
| Beat | Optional | Field-level territory reference. |
| Distributor ID | Optional | Reference only, no validation. |
| Distributor Name | Optional | Reference only. |
| Metro | Optional | If present, must be `Yes` or `No` (case-insensitive). |
| **City** | **Required** | Any string. |
| **State** | **Required** | Any string (the KYC form uses a state dropdown, but the master upload accepts free text). |
| Zone | Optional | Geographic zone reference. |
| **XSR ID** | **Required** (new) | Must be an existing **leaf-level (XSR)** employee from the hierarchy upload (`emp.roleCode === leafRoleCode`). Only XSR (field-level) employees can own outlets. |

- **Gotchas:** ≤500 rows per request (the FE auto-chunks a big file into ≤500 batches and aggregates
  the result; backend cap unchanged). All-blank rows are silently skipped. New outlets are created
  `isActive=false` (PENDING) until KYC approval. A failed batch downloads a **full-file** error
  report (every original column + a leading `Row` locator + a **Remarks** annotation). The **XSR ID
  column must carry the real `XSR-*` employee IDs**, not route/territory labels — a mismatch rejects
  the row (`#76` note: types are `SSS / SSS_TOT / SUB_STOCKIST / WHOLESALER`).

### (c) Sales users

- There is **no separate sales-user file**. The sales hierarchy chain upload (a) **is** the bulk
  sales-user create — it provisions a `User` + `SalesUser` per employee ID, at the level its column
  group implies. Fill template (a) completely and the sales users are created.
- For **ad-hoc** additions after the chain is loaded, use `POST /v1/admin/users` (one user at a time)
  with: `phone` (10 digits), `name`, `role` (a `SALES_*` role), optional `email`
  (`api/src/admin-core/dto/users.dto.ts:20-34`). A CLIENT_ADMIN may assign the SALES_* roles; only a
  GIFSY_ADMIN may mint CLIENT_ADMIN/GIFSY_ADMIN.

---

## C. Quick launch order

1. Bootstrap (seed-only): GIFSY_ADMIN + 4 OutletType master rows → see [`PROD-DATA-LOAD.md`](PROD-DATA-LOAD.md) §0.
2. Create Client `deoleo` (`POST /v1/gifsy/clients`).
3. Create first CLIENT_ADMIN (`POST /v1/admin/users` as GIFSY_ADMIN).
4. **§A settings** — set `outletPrograms`/`outletCategories` + create credit fields and their
   **award maps** + conversion rate + visibility OFF + channels/caps/upi.
5. Upload hierarchy chain (template a) → `PUT /v1/admin/hierarchy-config`.
6. Upload outlet master (template b) → `POST /v1/admin/outlets/upsert`.
7. KYC runs in-app afterward; credit uploads only after award maps are set.
