# "This month's offers" tiles — implementation plan

> **Status:** BUILT on `feat/upi-manual-entry` (BE `aab09f6` + audit fix `7d53cb7`; FE fix rounds
> `0202fce` + the copy-warnings round). Where this plan and the shipped code differ, **§0.1 "Shipped
> behaviour" wins** — the original plan text below is kept for context and is updated inline where it
> was contradicted.
> **Classification:** ⚠️ **PLATFORM-WIDE** (new Prisma table, shared partner-dashboard code, shared
> admin nav). **Owner-approved as platform-wide-but-dormant.** It stays dormant because the partner
> section renders nothing unless an active tile applies to that outlet; see §9 for the Deoleo
> byte-identical guarantee and **D1** for the one admin-nav exception.
> **Reader:** an engineer with ZERO context on this codebase. Read §0–§3 before you touch code.

---

## 0. What we are building (one paragraph)

Admins (GIFSY_ADMIN while working inside a tenant, or that tenant's CLIENT_ADMIN) create **offer
tiles** for one tenant. A tile is display-only: something like "+35 pts per case · ADHO 50 ml · Earn
on every case", in one of two groups: **"Earn on your targets"** (`TARGET_REWARD`) or **"Extra
schemes this month"** (`EXTRA_SCHEME`). It has an IST validity window, an audience segment (program,
outlet type, zone, state) and can be linked to a target KPI. On the **partner** dashboard (never the
sales app), a section called "This month's offers" appears below the Target & Achievement card. It
shows a 2-column grid of the tiles that apply to the logged-in outlet. A tile linked to a KPI also
shows **this outlet's** live progress (achieved/target %, "Unlocked" at ≥100%). Tapping a tile opens
a bottom sheet with its details and terms. Tiles **never credit, compute or promise points
programmatically**: they are content. If no tile applies, the section is absent from the page.

### 0.1 Shipped behaviour (authoritative — supersedes the plan text where they differ)

- **The `offerTiles` flag gates the WHOLE feature** (default OFF; Deoleo OFF): the admin nav item +
  `/admin/offers` route (FE gate; a failed settings fetch shows "Couldn't load settings — Retry", never
  "not enabled"), every admin API call (403 when OFF), the partner API (`tiles: []` when OFF), AND
  the partner dashboard, which mounts `OffersSection` only when `identity.features.offerTiles` is
  true — so a flag-OFF tenant makes **zero** offers requests.
- **Progress:** `pct = floor(achieved/target*100)` clamped to 0–100 and **capped at 99 unless
  unlocked**; `pct` is 100 **only** when `unlocked` (achieved ≥ target). Negative/NaN achieved → 0. A
  disabled KPI → `progress: null`. The FE shows the "Unlocked" pill exactly when `unlocked`, never a
  full bar without it, and clamps `aria-valuenow` to 0–100.
- **Validation (400, human form-label messages shown verbatim by the admin form):** an explicit
  `null` on any non-nullable field (POST or PATCH) → 400 (send `[]` to target everyone); validity
  window ≤ **366 days**, years **2020–2100**; `sortOrder` whole number **0–1,000,000**; value > 0,
  ≤ 9,999,999 (PERCENT ≤ 100); TEXT value 1–12 chars. The admin form mirrors these client-side.
- **Publish re-check:** PATCH `isActive` false→true re-validates `kpiCode` (exists + enabled) and
  `outletTypeCodes` (still exist); a dead reference refuses the publish with a human message.
- **Copy last month:** idempotent on **(`copiedFromId`, `copiedToMonth`)** — not on the editable
  `validFrom`; a per-(tenant, toMonth) advisory lock serialises double-clicks. Copies land as drafts.
  The result adds `kpiCleared: string[]` (new copy ids whose dead KPI link was removed → no progress
  bar) and `unknownOutletTypes: string[]` (new copy ids that keep outlet types which no longer exist —
  kept rather than dropped because dropping could widen the audience to "all"; publishing is refused
  until fixed). The admin page shows these in plain words ("2 copies had their target link removed…",
  "1 copy has outlet types that no longer exist — fix before publishing.") and marks the affected
  draft rows; the unknown-outlet-type mark is also derived from the tenant's outlet-type list, so it
  survives a reload.
- **Admin UI:** month + year `<select>` pair (no `type="month"`), stale month responses ignored,
  copy-count fetch failure shown as an error (not "nothing to copy").
- **Partner UI:** value never truncates (shrinks/wraps at 320–360px; the unit label sits on its own
  truncating line); small print is `text-xs text-gray-600`; the sheet keeps the last tile while
  closing and pads for the iOS safe area; footer wording "Offer details are shared by {brand}. Terms
  apply." unchanged.

---

## 1. Codebase orientation (verified, with citations)

Paths are relative to the repo root `C:\Users\nikun\Loyaltybaseclaude`.

### 1.1 Architecture
- `api/` = NestJS + Prisma. It owns the DB and **all** business logic. Routes are served under `/v1/*`.
- `platform/` = a **non-standard Next.js**. Read `platform/AGENTS.md` before you write FE code: the
  version has breaking changes, and its docs are in `platform/node_modules/next/dist/docs/`.
- The FE calls `/api/*`, which `platform/next.config.ts` (`rewrites()`, ~line 22) proxies to
  `${NEXT_PUBLIC_API_URL}/v1/:path*`. **No FE route handler is needed** for a new backend endpoint.
- `platform/src/proxy.ts` (~lines 166–278) injects the auth cookie as a Bearer token and injects
  **`x-active-partner-id`** (the multi-outlet "active outlet" selector). It strips any copy the client
  supplied. The backend **re-authorizes** that header with `resolveActivePartnerId`.
- Responses are wrapped globally as `{ success: true, data: <service return> }`. The FE helper
  `platform/src/lib/api-client.ts` (`api.get/post/put/patch/del`, lines 69–74) returns
  `ApiResponse<T> = {success:true,data:T} | {success:false,error,status?}`.

### 1.2 Partner dashboard (where the tiles render)
- Page: `platform/src/app/partner/dashboard/page.tsx` (1181 lines, single file).
  - **Two variants** keyed by the tenant feature `partnerDashboardV2`, read at line 912:
    `const v2 = !!identity.features?.partnerDashboardV2;` (identity comes from `/partner/me` via
    `usePartnerIdentity`). Deoleo is v2=OFF and Bajaj is v2=ON.
  - Render order (lines 1112–1139): hero (Wholesaler/MT/Retailer) → `<SchemesCard/>` → **v2:**
    `<PerformanceCard/>`, **non-v2:** `<PerformanceChart/>` (the Target-vs-Achievement chart) →
    `{v2 && <TargetAchievementCard aggKpis={aggKpis}/>}` (line 1136) → `<QuickActions/>` → popup.
  - `TargetAchievementCard` (lines 441–527) is **v2-only**. It is a pure render from `aggKpis`. Those
    come from `GET /api/partner/targets?period=YYYY-MM` (lines 939–995) and are aggregated per KPI
    across all of the partner's outlets: target and achieved are summed, and null counts as 0.
  - `SchemesCard` (lines 835–885) is the **pattern to copy**: a self-contained widget that fetches in
    `useEffect`, starts `null`, renders `null` on empty or error, and never blocks the page.
  - The page shows a spinner until `loading || identity.loading` (line 1025). Children mount after
    that.
- **Hydration lesson (#58, `platform/docs/plans/RESUME.md` line 20):** the React #418 hydration error
  on every partner page came from reading `localStorage` during the **initial render**. The rule is
  that the initial render must be deterministic. Start empty, and fetch or read client-only state
  inside `useEffect`. No `Date`-dependent text before mount either.
- Existing tests: `platform/src/app/partner/dashboard/__tests__/*.test.tsx`. Use
  `partner-dashboard-v2.test.tsx` for the harness: it mocks `@/lib/partner-identity`, `@/lib/banner`,
  `portal-api` and `next/link`.

### 1.3 Targets / achievement data (for KPI-linked progress)
- `api/prisma/schema.prisma`:
  - `KpiDef` (line 2951): `clientId, code, label, unit, isPrimary, rollup, outletType?, enabled`, plus
    `@@unique([clientId, code])`.
  - `OutletTarget` (line 3005): `clientId, outletCode, month ('YYYY-MM'), targetValues Json`, plus
    `@@unique([clientId, outletCode, month])`. `targetValues` is `{ [kpiCode]: number, __names?: {...} }`.
  - `OutletSalesRecord` (line 2923): the same key, with `kpiValues Json` (achievement).
- Partner computation: `api/src/partner/partner.service.ts` `getTargets` (lines 358–490). Steps:
  `resolveActivePartner` → active outlets of that partner (`clientId, partnerId, isActive:true,
  deletedAt:null`) → targets and achievements for `month` joined on outletCode → per-KPI
  `{code,name,target,achieved,pace,unit,isPrimary}`. Use `kpiCodeKeys()` / `NAMES_KEY` from
  `api/src/targets/targets.helpers.ts` (lines 51–61) so `__names` is never treated as a KPI.
- Month keys: `istMonthKey(d)` / `istDateKey(d)` in `api/src/common/ist-date.ts` (lines 123, 135)
  return `YYYY-MM` / `YYYY-MM-DD` in IST.

### 1.4 Outlet segmentation (verified on `model Outlet`, schema line 1217)
- `programName String?`, `programCategory String?`, `zone String?`, `state String` (required),
  `outletTypeId` → `OutletType.code` (a global master: `SSS`, `WHOLESALER`, `SSS_TOT`, …), and
  `metro`, `beat`, `distributorCode`. These are set by the admin outlet-master upload.
- Per-tenant enabled outlet types with display labels: `GET /v1/settings/outlet-types`
  (`api/src/tenant/tenant-settings.controller.ts` line 49). It is open to any authenticated role and
  returns `{code,label,name,displayName}[]`. **Reuse it.**
- Tenant KPI list: `GET /v1/admin/kpis` (`api/src/targets/targets.controller.ts` lines 62–73,
  `@Roles('CLIENT_ADMIN','GIFSY_ADMIN')` + `targets:read`). **Reuse it.**
- There is **no** existing endpoint for the distinct `programName` / `zone` / `state` values, so we add
  one (B4).

### 1.5 Comparable per-tenant admin content to copy patterns from
- **Banners** are the closest analogue (per-tenant engagement content shown to partners):
  - `api/src/admin-programs/banners.controller.ts`: write routes use
    `@Roles('GIFSY_ADMIN','CLIENT_ADMIN')` + `@RequirePermission('engagement:manage_banners')`, and
    read uses `engagement:read`.
  - `api/src/admin-programs/banners.service.ts`: `clientId: user.clientId` on every query, soft
    delete via `deletedAt`, IST end-of-day comparison using `startOfIstDay`.
  - `api/src/admin-programs/banner-config.service.ts` (lines 50–60): **audit-log pattern**
    `prisma.auditLog.create({ data: { actorId: user.sub, action: 'UPDATE', entityType, entityId, newValues } })`.
  - The partner read is `GET /v1/partner/banners` on `api/src/partner/partner.controller.ts`
    (lines 44–48, `@RequirePermission('engagement:read')`, controller-level
    `@Roles('SSS','WHOLESALER','SUB_STOCKIST')`).
- `AuditLog` model (schema line 759): it has **no clientId column**. Put `clientId` in `metadata`.
  `AuditAction` enum (line 56): `CREATE|UPDATE|DELETE|…`.
- RBAC: `api/src/common/rbac/permissions.ts` `ENGAGEMENT` (lines 247–252). `RolesGuard`
  (`api/src/common/guards/roles.guard.ts` line 22) lets GIFSY_ADMIN pass every `@Roles`.
  `PermissionGuard` always enforces for GIFSY_STAFF and is flag-gated for legacy roles.
- Tenant scoping: `api/src/common/tenant-scope.ts`. `platformWide(user)` is true **only** for an
  **un-assumed** GIFSY_ADMIN. When assumed, `user.clientId` is the tenant. The admin content we write
  is per-tenant, so **writes and reads require a tenant context**. If `platformWide(user)`, respond
  400 "Assume a tenant to manage offers". Otherwise rows would be written under `clientId='gifsy'`.
- Controller spec pattern: `api/src/notification-templates/notification-templates.controller.spec.ts`
  (it reads `ROLES_KEY` metadata with `Reflector`). The permission metadata key is `PERMISSION_KEY`
  (`api/src/common/decorators/require-permission.decorator.ts` line 4).
- Service spec pattern: `api/src/partner/partner.service.spec.ts` (a hand-rolled `mockPrisma` object
  with `jest.fn()` per model method, wired through `Test.createTestingModule`).
- Admin FE:
  - Nav: `platform/src/app/admin/layout.tsx` `ALL_NAV_ITEMS` (lines 52–209). The role-gated item
    flags `giftDisbursal` / `deliveryReport` (GIFSY_ADMIN + CLIENT_ADMIN only) are filtered at lines
    253–260, and a tenant-feature gate is `featureFlag: '<key>'` (line 268).
  - Route guard: `platform/src/app/admin/notification-delivery/layout.tsx`
    (`<RequireAuth allowedRoles={['GIFSY_ADMIN','CLIENT_ADMIN']}>`).
  - GIFSY_STAFF route→permission map: `platform/src/lib/rbac/route-permissions.ts` (`'/admin/banners': 'engagement:read'`).
  - Page test harness: `platform/src/app/admin/notification-delivery/__tests__/notification-delivery.test.tsx`
    (it mocks `@/lib/api-client` and `@/lib/admin-session`).
  - Modal: `platform/src/components/ui/modal.tsx` (Radix Dialog; takes a `className` override, so it
    can be a bottom sheet).
- Tenant feature flags (needed only if D1 = flag): the `partnerDashboardV2` plumbing is
  `platform/src/lib/platform/client-config.ts:65`, `default-client-config.ts:53`,
  `platform/src/lib/tenant-features.ts:65`, `api/src/gifsy/gifsy.service.ts:617,762,1014`, and labels
  in `platform/src/app/gifsy/clients/new/page.tsx:50,68` and `.../clients/[slug]/page.tsx:34`.

### 1.6 Migrations / seed / Docker trap
- Migration folder naming is `api/prisma/migrations/YYYYMMDDHHMMSS_snake_name/migration.sql`. The
  latest is `20261107120000_partner_upi_capture_method`. Ours is **`20261109120000_add_offer_tiles`**.
  Bump the timestamp if something newer lands first.
- `platform/docs/plans/MIGRATIONS.md`: migrations are applied with `prisma migrate deploy` only.
  **Never run `prisma migrate dev`**, because it resets `gifsy_dev`. Generate SQL with
  `prisma migrate diff` and hand-review it.
- `prisma generate` is required before gating a schema change. Otherwise `tsc` and jest see stale
  types.
- **Docker trap** (`api/Dockerfile` lines 12–28): `prisma/seed.ts` and `prisma/bootstrap.ts` are
  compiled **separately** with standalone `tsc` into self-contained output. Anything they import from
  `src/` must be pure, with no Nest DI and no new npm deps. **This plan does not touch seed.ts or
  bootstrap.ts.** Demo tiles are created through the admin UI. A related trap (memory, delivery-status
  work): importing an npm package that is not in `api/package.json` passes the gates but crashes at
  boot. Add **no new dependencies**.

### 1.7 Gates
- `bash scripts/gates.sh` runs api jest, nest build, platform vitest and platform tsc, and exits
  non-zero on any failure. `--fast` runs only the compile gates. **Never pipe a gate into
  `tail`/`head`.**

---

## 2. Data model

### 2.1 Prisma (add to `api/prisma/schema.prisma`, new section after `OutletTarget`, ~line 3025)

```prisma
// ─── MODULE: OFFER TILES — per-tenant "This month's offers" content (display-only) ───
// Admin-authored tiles shown on the PARTNER dashboard. DISPLAY-ONLY: nothing here credits,
// computes or reserves points. Value is identical for every outlet in the segment; only the
// optional KPI progress (OutletTarget/OutletSalesRecord) is per-outlet, computed at read time.
// Additive + dormant: zero rows ⇒ partner dashboard renders no section (Deoleo byte-identical).

enum OfferValueType {
  POINTS
  PERCENT
  RUPEES
  TEXT
}

enum OfferGroup {
  TARGET_REWARD // "Earn on your targets"
  EXTRA_SCHEME  // "Extra schemes this month"
}

model OfferTile {
  id          String         @id @default(cuid())
  clientId    String
  group       OfferGroup
  valueType   OfferValueType
  // Exactly one of valueNumber / valueText is set (service-validated):
  //   POINTS | PERCENT | RUPEES → valueNumber (> 0, ≤ 2 dp); TEXT → valueText (≤ 12 chars).
  valueNumber Decimal?       @db.Decimal(12, 2)
  valueText   String?
  unitLabel   String?        // "per case"
  product     String?        // "ADHO 50 ml"
  label       String         // headline
  details     String?        // plain-text details / terms (bottom sheet)
  validFrom   DateTime       @db.Date // IST calendar day, inclusive
  validTo     DateTime       @db.Date // IST calendar day, inclusive
  sortOrder   Int            @default(0)
  isActive    Boolean        @default(true) // publish toggle; copies land FALSE (see D3)
  // Targeting — EMPTY array = "all". Matched case-insensitively against the outlet master.
  programNames    String[]   @default([])
  outletTypeCodes String[]   @default([]) // OutletType.code
  zones           String[]   @default([])
  states          String[]   @default([])
  // Optional link to a tenant KPI (KpiDef.code) → per-outlet live progress.
  kpiCode     String?
  copiedFromId String?       // set by "Copy last month" (idempotency key)
  createdById String
  updatedById String?
  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt
  deletedAt   DateTime?

  @@index([clientId, deletedAt, validFrom, validTo])
  @@index([clientId, copiedFromId])
  @@map("offer_tiles")
}
```

Why these choices:
- `@db.Date` for the IST day follows the `PointsRule.effectiveFrom` precedent (schema line 3044).
- Arrays with empty-means-all keep the schema to one table and need no join tables (YAGNI).
- Prisma enums are created with `CREATE TYPE`, which is additive. Strings would also work; we use
  enums for DTO safety.

### 2.2 Migration `api/prisma/migrations/20261109120000_add_offer_tiles/migration.sql`

Generate it, don't hand-type it. Then compare it with the SQL below. Run from `api/`:

```bash
git show HEAD:api/prisma/schema.prisma > /tmp/schema.before.prisma
npx prisma migrate diff --from-schema /tmp/schema.before.prisma --to-schema prisma/schema.prisma --script
```

Expected output (hand-check that it is purely additive: no `ALTER`/`DROP` on existing tables):

```sql
-- Offer tiles ("This month's offers" on the partner dashboard). ADDITIVE ONLY:
-- 2 new enum types + 1 new table + 2 indexes. No existing table touched → every tenant byte-identical.
CREATE TYPE "OfferValueType" AS ENUM ('POINTS', 'PERCENT', 'RUPEES', 'TEXT');
CREATE TYPE "OfferGroup" AS ENUM ('TARGET_REWARD', 'EXTRA_SCHEME');

CREATE TABLE "offer_tiles" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "group" "OfferGroup" NOT NULL,
    "valueType" "OfferValueType" NOT NULL,
    "valueNumber" DECIMAL(12,2),
    "valueText" TEXT,
    "unitLabel" TEXT,
    "product" TEXT,
    "label" TEXT NOT NULL,
    "details" TEXT,
    "validFrom" DATE NOT NULL,
    "validTo" DATE NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "programNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outletTypeCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "zones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "states" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kpiCode" TEXT,
    "copiedFromId" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "offer_tiles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "offer_tiles_clientId_deletedAt_validFrom_validTo_idx" ON "offer_tiles"("clientId", "deletedAt", "validFrom", "validTo");
CREATE INDEX "offer_tiles_clientId_copiedFromId_idx" ON "offer_tiles"("clientId", "copiedFromId");
```

After that run `npx prisma generate` (from `api/`). Apply locally with `npx prisma migrate deploy`
against `gifsy_dev` (see `DEV-DB.md`). On staging it is applied by the in-VPC Cloud Run migrate job
as part of the normal deploy.

---

## 3. API CONTRACT (both lanes code against this — do not change without telling the other lane)

All responses are wrapped by the global interceptor: `{ "success": true, "data": <below> }`.
FE paths are `/api/...`, which proxy to BE `/v1/...`.

### 3.1 Shared types (TypeScript; BE lives in `api/src/offers/offers.types.ts`, FE mirrors in `platform/src/lib/offers.ts`)

```ts
export type OfferValueType = 'POINTS' | 'PERCENT' | 'RUPEES' | 'TEXT';
export type OfferGroup = 'TARGET_REWARD' | 'EXTRA_SCHEME';

/** Admin view of a tile (dates are IST calendar days 'YYYY-MM-DD'). */
export interface OfferTileAdmin {
  id: string;
  group: OfferGroup;
  valueType: OfferValueType;
  valueNumber: number | null;   // Decimal serialized as a JS number by the service
  valueText: string | null;
  unitLabel: string | null;
  product: string | null;
  label: string;
  details: string | null;
  validFrom: string;            // 'YYYY-MM-DD'
  validTo: string;              // 'YYYY-MM-DD'
  sortOrder: number;
  isActive: boolean;
  programNames: string[];
  outletTypeCodes: string[];
  zones: string[];
  states: string[];
  kpiCode: string | null;
  copiedFromId: string | null;
  copiedToMonth: string | null; // 'YYYY-MM' the copy was made into (copy idempotency key with copiedFromId)
  createdAt: string;            // ISO
  updatedAt: string;            // ISO
}

/** Partner view — no targeting/audit fields leak to partners. */
export interface OfferTilePartner {
  id: string;
  group: OfferGroup;
  valueType: OfferValueType;
  valueNumber: number | null;
  valueText: string | null;
  unitLabel: string | null;
  product: string | null;
  label: string;
  details: string | null;
  validTo: string;              // 'YYYY-MM-DD'
  progress: null | {            // null when the tile has no kpiCode
    kpiCode: string;
    kpiName: string;            // KpiDef.label (fallback: code)
    unit: string;               // KpiDef.unit
    target: number | null;      // null ⇒ this outlet has no target for the KPI this month
    achieved: number;           // 0 when no achievement row
    pct: number | null;         // floor(achieved/target*100), 0–100, capped at 99 unless unlocked; null when target null/0
    unlocked: boolean;          // target > 0 && achieved >= target
  };
}
```

### 3.2 Partner endpoint

`GET /v1/partner/offers` (FE `GET /api/partner/offers`). Roles `SSS | WHOLESALER | SUB_STOCKIST`
(controller-level, like `PartnerController`) + `@RequirePermission('engagement:read')`. Honors
`x-active-partner-id` (re-authorized).

Response `data`:
```json
{
  "asOf": "2026-11-09",
  "month": "2026-11",
  "tiles": [
    {
      "id": "ck…1", "group": "TARGET_REWARD", "valueType": "POINTS",
      "valueNumber": 35, "valueText": null, "unitLabel": "per case",
      "product": "ADHO 50 ml", "label": "Earn on every case", "details": "Valid on billed cases only.",
      "validTo": "2026-11-30",
      "progress": { "kpiCode": "ADHO50", "kpiName": "ADHO 50 ml", "unit": "cases",
                    "target": 200, "achieved": 120, "pct": 60, "unlocked": false }
    },
    {
      "id": "ck…2", "group": "EXTRA_SCHEME", "valueType": "PERCENT",
      "valueNumber": 2.5, "valueText": null, "unitLabel": "extra margin",
      "product": "Olive Pomace 1 L", "label": "Festive bonus", "details": null,
      "validTo": "2026-11-15", "progress": null
    }
  ]
}
```
- `tiles` is sorted by `group` (`TARGET_REWARD` first), then `sortOrder` ascending, then `createdAt`
  ascending.
- No partner, no active outlets, or no matching tile → `{ "asOf": "...", "month": "...", "tiles": [] }`
  (**200, never 404**).
- A forged `x-active-partner-id` → **403** (same as `/partner/targets`).

### 3.3 Admin endpoints

All of them: `@Roles('GIFSY_ADMIN','CLIENT_ADMIN')`. Reads use `@RequirePermission('engagement:read')`
and writes use `@RequirePermission('engagement:manage_banners')` (see D2). An **un-assumed
GIFSY_ADMIN** (`platformWide(user)`) gets **400** `{ message: "Assume a tenant to manage offers." }`
on every route.

| Method | Path (BE) | Body / query | `data` |
|---|---|---|---|
| GET | `/v1/admin/offers?month=YYYY-MM` | `month` required | `{ month, tiles: OfferTileAdmin[] }`: non-deleted tiles whose `[validFrom,validTo]` **overlaps** the month, sorted like §3.2 |
| GET | `/v1/admin/offers/segment-options` | — | `{ programNames: string[], zones: string[], states: string[] }`: distinct non-null, trimmed, sorted values from this tenant's non-deleted outlets |
| POST | `/v1/admin/offers` | `OfferTileInput` | `{ tile: OfferTileAdmin }` (201) |
| PATCH | `/v1/admin/offers/:id` | `Partial<OfferTileInput>` | `{ tile: OfferTileAdmin }` |
| DELETE | `/v1/admin/offers/:id` | — | `{ id }` (soft delete) |
| POST | `/v1/admin/offers/copy-month` | `{ fromMonth: "YYYY-MM", toMonth: "YYYY-MM" }` | `{ created: number, skipped: number, kpiCleared: string[], unknownOutletTypes: string[], tiles: OfferTileAdmin[] }` |

Outlet types and KPIs come from the **existing** `GET /v1/settings/outlet-types` and
`GET /v1/admin/kpis?enabledOnly=true` (`ListKpisQueryDto.enabledOnly`, verified in `api/src/targets/dto`).

`OfferTileInput`:
```json
{
  "group": "TARGET_REWARD",
  "valueType": "POINTS",
  "valueNumber": 35,
  "valueText": null,
  "unitLabel": "per case",
  "product": "ADHO 50 ml",
  "label": "Earn on every case",
  "details": "Valid on billed cases only.",
  "validFrom": "2026-11-01",
  "validTo": "2026-11-30",
  "sortOrder": 0,
  "isActive": true,
  "programNames": ["Gold"],
  "outletTypeCodes": ["WHOLESALER"],
  "zones": [],
  "states": [],
  "kpiCode": "ADHO50"
}
```

Validation rules. Breaking any of them gives **400** with a human message, and the admin form shows
it verbatim:
- `label` 1–60 chars; `product` ≤ 40; `unitLabel` ≤ 20; `details` ≤ 1000. All are trimmed, and empty
  becomes null (label must stay non-empty).
- `valueType ∈ POINTS|PERCENT|RUPEES` ⇒ `valueNumber` is required, `0 < n ≤ 9,999,999`, at most 2
  decimal places, and `valueText` is forced to null. `PERCENT` additionally requires `n ≤ 100`.
- `valueType = TEXT` ⇒ `valueText` is required, 1–12 chars (it must fit the big tile number slot),
  and `valueNumber` is forced to null.
- `validFrom`/`validTo` match `^\d{4}-\d{2}-\d{2}$`, are real dates, and `validTo >= validFrom`;
  years 2020–2100 and a window of at most 366 days.
- An explicit `null` on any non-nullable field (POST or PATCH) → 400. `sortOrder` is a whole number
  0–1,000,000.
- PATCH `isActive` false→true re-validates `kpiCode` and `outletTypeCodes` against the live masters.
- Each array has ≤ 50 entries of ≤ 80 chars, trimmed, with empties dropped.
  `outletTypeCodes ⊆ codes from /settings/outlet-types for the tenant`.
- `kpiCode` (nullable) must exist in `KpiDef` for `clientId` with `enabled: true`. Otherwise 400
  "Unknown KPI".
- PATCH validates the **merged** row (existing + patch) under the same rules. A PATCH or DELETE of an
  id that is not in this tenant, or is already deleted, gives **404**.

Copy-month semantics:
- Source = non-deleted tiles with `validFrom` inside `fromMonth` (IST).
- Each copy gets `validFrom = <toMonth>-01` and `validTo = last day of toMonth`, `isActive = false`
  (draft, see D3), `copiedFromId = source.id` and `copiedToMonth = toMonth`. Every other field is
  copied verbatim, except a dead KPI link is nulled (id reported in `kpiCleared`); outlet types that
  no longer exist are kept and reported in `unknownOutletTypes` (publish refused until fixed).
- **Idempotent:** a source with a non-deleted copy tagged `copiedToMonth = toMonth` (same
  `copiedFromId`) is skipped and counted in `skipped` — editing the copy's `validFrom` does not
  defeat this. A per-(tenant, toMonth) advisory lock serialises concurrent copies.
- `fromMonth === toMonth` → 400.
- Runs in one `$transaction` and writes one audit row with action `CREATE`, entityType `OFFER_TILE`,
  entityId `copy:<from>→<to>`, and the created ids in `metadata`.

---

## 4. Lane split

| Lane | Owns | Must not touch |
|---|---|---|
| **Backend (BE)** | `api/prisma/schema.prisma`, the new migration, `api/src/offers/**`, `api/src/app.module.ts` (one import line), BE specs | anything in `platform/` |
| **Frontend (FE)** | `platform/src/lib/offers.ts`, `platform/src/components/partner/offers/**`, `platform/src/app/partner/dashboard/page.tsx` (one insertion), `platform/src/app/admin/offers/**`, `platform/src/app/admin/layout.tsx` (nav item), `platform/src/lib/rbac/route-permissions.ts`, FE tests | anything in `api/` |

FE can be built fully against §3 with mocked `api-client`/`fetch`, so there is no runtime dependency
until integration (§7). If D1 = "feature flag", the flag plumbing is task **X1**. It touches both
sides, so assign it to the BE lane, which hands the FE the `features.offerTiles` key.

---

## 5. BACKEND LANE — tasks

Run every jest command from `api/`: `npx jest <path> --no-coverage`.

### B1. Schema + migration
- **Modify** `api/prisma/schema.prisma` (§2.1). **Create**
  `api/prisma/migrations/20261109120000_add_offer_tiles/migration.sql` (§2.2).
- **Test first:** there is no unit test for SQL. Instead: run `npx prisma validate` and
  `npx prisma generate`, then `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --shadow-database-url <local shadow>`.
  If no shadow DB is available, the git-show diff from §2.2 must be empty after the migration is
  added. Expected: **no drift**.
- **Verify:** apply it to local `gifsy_dev` with `npx prisma migrate deploy`. Then
  `psql -c '\d offer_tiles'` shows the columns and both indexes.

### B2. Pure helpers (`api/src/offers/offers.helpers.ts`) — TDD
Pure functions with no Prisma. They make the service thin and the edge cases testable.

**Test first** in `api/src/offers/offers.helpers.spec.ts`:
```ts
import { istDayToDate, dateToIstDay, monthBounds, outletMatches, computeProgress, validateTileInput } from './offers.helpers';

describe('offers.helpers', () => {
  it('istDayToDate/dateToIstDay round-trip a calendar day (no TZ drift)', () => {
    expect(dateToIstDay(istDayToDate('2026-11-30'))).toBe('2026-11-30');
  });
  it('monthBounds gives first/last IST day', () => {
    expect(monthBounds('2026-02')).toEqual({ first: '2026-02-01', last: '2026-02-28' });
    expect(monthBounds('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
  });
  it('outletMatches: empty arrays = all; case/space-insensitive', () => {
    const tile = { programNames: ['Gold'], outletTypeCodes: [], zones: [], states: ['Maharashtra'] };
    expect(outletMatches(tile, { programName: ' gold ', outletTypeCode: 'SSS', zone: null, state: 'MAHARASHTRA' })).toBe(true);
    expect(outletMatches(tile, { programName: null, outletTypeCode: 'SSS', zone: null, state: 'Maharashtra' })).toBe(false);
  });
  it('computeProgress: target 0/absent → pct null, not unlocked; ≥100% → unlocked', () => {
    expect(computeProgress(null, 5)).toEqual({ target: null, achieved: 5, pct: null, unlocked: false });
    expect(computeProgress(0, 5)).toEqual({ target: 0, achieved: 5, pct: null, unlocked: false });
    expect(computeProgress(200, 120)).toEqual({ target: 200, achieved: 120, pct: 60, unlocked: false });
    expect(computeProgress(200, 200)).toMatchObject({ pct: 100, unlocked: true });
    expect(computeProgress(200, 260)).toMatchObject({ pct: 130, unlocked: true });
  });
  it('validateTileInput enforces value-type rules', () => {
    expect(() => validateTileInput({ ...base, valueType: 'PERCENT', valueNumber: 120 })).toThrow(/100/);
    expect(() => validateTileInput({ ...base, valueType: 'TEXT', valueText: '' })).toThrow();
    expect(validateTileInput({ ...base, valueType: 'TEXT', valueText: 'Free kit', valueNumber: 5 }).valueNumber).toBeNull();
    expect(() => validateTileInput({ ...base, validFrom: '2026-11-30', validTo: '2026-11-01' })).toThrow(/validTo/);
    expect(() => validateTileInput({ ...base, valueNumber: 1.234 })).toThrow(/2 decimal/);
  });
});
// `base` = a valid OfferTileInput fixture defined at the top of the spec.
```

**Implement** (sketch):
```ts
import { BadRequestException } from '@nestjs/common';

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** 'YYYY-MM-DD' (IST calendar day) → Date at 00:00 UTC, which is how Prisma @db.Date round-trips. */
export function istDayToDate(day: string): Date { return new Date(`${day}T00:00:00.000Z`); }
export function dateToIstDay(d: Date): string { return d.toISOString().slice(0, 10); } // @db.Date is TZ-less

export function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, '0')}` };
}

export interface OutletSeg { programName: string | null; outletTypeCode: string | null; zone: string | null; state: string | null }
export function outletMatches(
  t: { programNames: string[]; outletTypeCodes: string[]; zones: string[]; states: string[] },
  o: OutletSeg,
): boolean {
  const ok = (list: string[], v: string | null) => list.length === 0 || list.some((x) => norm(x) === norm(v));
  return ok(t.programNames, o.programName) && ok(t.outletTypeCodes, o.outletTypeCode)
      && ok(t.zones, o.zone) && ok(t.states, o.state);
}

export function computeProgress(target: number | null, achieved: number) {
  const pct = target && target > 0 ? Math.round((achieved / target) * 100) : null;
  return { target, achieved, pct, unlocked: !!target && target > 0 && achieved >= target };
}
// validateTileInput(input) → normalized input or throws BadRequestException (rules from §3.3).
```
> `dateToIstDay` uses `toISOString()` **deliberately**. A `@db.Date` value comes back from Prisma as
> 00:00 UTC of that calendar day, so the UTC date *is* the stored IST day. Write a comment saying
> this so nobody "fixes" it to `istDateKey`, which would shift it by +5:30 and give the same answer
> only by accident.

### B3. DTOs (`api/src/offers/dto/offers.dto.ts`)
Use class-validator in the `api/src/admin-programs/dto/banners.dto.ts` style: `CreateOfferTileDto`
(all §3.3 fields, `@IsEnum`, `@Matches(/^\d{4}-\d{2}-\d{2}$/)`, `@IsArray() @ArrayMaxSize(50) @IsString({each:true}) @MaxLength(80,{each:true})`,
`@IsOptional()` where nullable). Then `UpdateOfferTileDto`: write it **by hand**, with every field
`@IsOptional()`. `@nestjs/mapped-types` is **not** in `api/package.json` (verified), and adding it
would hit the boot-crash trap, so **no new deps**. `ListOffersQueryDto { @Matches(/^\d{4}-\d{2}$/) month }`, and
`CopyMonthDto { fromMonth, toMonth }`. Cross-field rules live in `validateTileInput` (B2), not in
decorators.

### B4. Admin service (`api/src/offers/offers-admin.service.ts`) — TDD
**Test first** in `api/src/offers/offers-admin.service.spec.ts`, with the mockPrisma pattern from
`partner.service.spec.ts`:
```ts
const mockPrisma = {
  offerTile: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  kpiDef:    { findFirst: jest.fn() },
  outlet:    { findMany: jest.fn() },
  auditLog:  { create: jest.fn() },
  $transaction: jest.fn(async (fn) => fn(mockPrisma)),
};
const tenantSettings = { getOutletTypes: jest.fn().mockResolvedValue([{ code: 'SSS' }, { code: 'WHOLESALER' }]) };
const admin = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' };
const ownerUnassumed = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '', assumed: false };
```
Cases (one `it` each):
1. `create` writes `clientId: user.clientId`, `createdById: user.sub`, the dates converted via
   `istDayToDate`, and an `auditLog.create` with `action:'CREATE', entityType:'OFFER_TILE'` and
   `metadata.clientId`. Both happen in the same `$transaction`.
2. `create` with an un-assumed GIFSY_ADMIN → `BadRequestException`, and no prisma write.
3. `create` with an unknown `kpiCode` (`kpiDef.findFirst → null`) → 400. The query must include
   `clientId` and `enabled: true`.
4. `create` with an `outletTypeCodes` entry not in the tenant's outlet types → 400.
5. `update` on another tenant's id (`findFirst({where:{id, clientId, deletedAt:null}}) → null`) → 404.
6. `update` validates the merged row. Example: an existing POINTS tile patched with
   `{ valueType:'TEXT' }` and no `valueText` → 400.
7. `remove` sets `deletedAt`, writes an audit `DELETE`, and does **not** hard-delete.
8. `list({month:'2026-11'})` queries with
   `{clientId, deletedAt:null, validFrom:{lte: 2026-11-30}, validTo:{gte: 2026-11-01}}` and maps
   Decimal to number and Date to `'YYYY-MM-DD'`.
9. `copyMonth` creates drafts (`isActive:false`, `copiedFromId`) for the October sources, skips one
   that is already copied, returns `{created, skipped}`, and rejects `fromMonth===toMonth`.
10. `segmentOptions` returns distinct, trimmed, sorted, non-null values from
    `outlet.findMany({ where:{clientId, deletedAt:null}, select:{programName,zone,state}, distinct? })`.
    Dedupe in JS after the trim and case-preserve the first-seen spelling.

**Implement.** Inject `PrismaService` + `TenantSettingsService` (`getOutletTypes(clientId)` exists;
see the tenant-settings controller line 51). Key snippet:
```ts
private assertTenant(user: JwtPayload) {
  if (platformWide(user)) throw new BadRequestException('Assume a tenant to manage offers.');
}

async create(user: JwtPayload, dto: CreateOfferTileDto) {
  this.assertTenant(user);
  const input = validateTileInput(dto);
  await this.assertRefs(user.clientId, input); // kpiCode + outletTypeCodes
  return this.prisma.$transaction(async (tx) => {
    const row = await tx.offerTile.create({ data: {
      ...toDbFields(input), clientId: user.clientId, createdById: user.sub,
    } });
    await tx.auditLog.create({ data: {
      actorId: user.sub, action: 'CREATE', entityType: 'OFFER_TILE', entityId: row.id,
      newValues: toAuditJson(row), metadata: { clientId: user.clientId },
    } });
    return { tile: toAdminView(row) };
  });
}
```
`toAdminView` converts `valueNumber` with `row.valueNumber === null ? null : Number(row.valueNumber)`
and the dates with `dateToIstDay`.

### B5. Partner service (`api/src/offers/offers-partner.service.ts`) — TDD
**Test first** in `api/src/offers/offers-partner.service.spec.ts`. Mock `resolveActivePartnerId` with
`jest.mock('../common/partner-group.helper', ...)` or by mocking its prisma reads. Mocking the module
is simpler: `jest.mock('../common/partner-group.helper', () => ({ resolveActivePartnerId: jest.fn() }))`.
Cases:
1. No partner (`partnerId:null`) → `{tiles:[]}`, and the `offerTile` query is never run.
2. `forbidden:true` → `ForbiddenException`.
3. Today filter: the `offerTile.findMany` where-clause is
   `{clientId, deletedAt:null, isActive:true, validFrom:{lte: today}, validTo:{gte: today}}`, with
   `today = istDayToDate(istDateKey(new Date()))`. Compute the expected value **relative to now**,
   and **never hardcode a date**.
4. Segment filtering: the partner has 2 outlets (`programName 'Gold'/'Silver'`). A tile targeted at
   `['Gold']` is returned, and one targeted at `['Platinum']` is not.
5. A KPI-linked tile sums target and achieved **only over the matching outlets**, for the current IST
   month (`istMonthKey(new Date())`). The `__names` key is ignored. `kpiName` comes from
   `KpiDef.label`.
6. A KPI-linked tile where no matching outlet has a target row → `progress.target === null`,
   `pct === null`, `unlocked === false`. **It is still returned.**
7. Sorting: TARGET_REWARD before EXTRA_SCHEME, then sortOrder, then createdAt.
8. Partner view has no `programNames`, `createdById` etc. (`expect(Object.keys(tile)).toEqual([...])`).

**Implement:**
```ts
async listForPartner(user: JwtPayload, requestedPartnerId?: string) {
  const now = new Date();
  const asOf = istDateKey(now), month = istMonthKey(now);
  const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
    clientId: user.clientId, userSub: user.sub, phone: user.phone, requestedPartnerId,
  });
  if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');
  if (!partnerId) return { asOf, month, tiles: [] };

  const today = istDayToDate(asOf);
  const tiles = await this.prisma.offerTile.findMany({
    where: { clientId: user.clientId, deletedAt: null, isActive: true,
             validFrom: { lte: today }, validTo: { gte: today } },
    orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  if (tiles.length === 0) return { asOf, month, tiles: [] }; // hot path for Deoleo: ONE extra query

  const outlets = await this.prisma.outlet.findMany({
    where: { clientId: user.clientId, partnerId, isActive: true, deletedAt: null },
    select: { outletCode: true, programName: true, zone: true, state: true,
              outletType: { select: { code: true } } },
  });
  // per tile: matching outlet codes; drop tiles with zero matches
  // if any kept tile has kpiCode → ONE outletTarget.findMany + ONE outletSalesRecord.findMany
  //   (clientId, month, outletCode IN union-of-matching-codes) + ONE kpiDef.findMany(code IN …)
  // progress = computeProgress(sumTarget|null, sumAchieved) over that tile's matching outlets
}
```
> Enum `orderBy group asc` sorts by Postgres enum **declaration order** (`TARGET_REWARD` first),
> which is what we want. Add a comment and keep the enum order.
> Resolve the active partner exactly as `PartnerService.resolveActivePartner` does (partner.service.ts
> lines 74–86). **Never** read `partnerId` from the query or body.

### B6. Controllers + module — TDD
Create `api/src/offers/offers.controller.ts` with two controller classes in one file:
```ts
@Controller('admin/offers')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class OffersAdminController {
  constructor(private readonly svc: OffersAdminService) {}
  @Get()                    @RequirePermission('engagement:read')
  list(@CurrentUser() u: JwtPayload, @Query() q: ListOffersQueryDto) { return this.svc.list(u, q.month); }
  @Get('segment-options')   @RequirePermission('engagement:read')
  options(@CurrentUser() u: JwtPayload) { return this.svc.segmentOptions(u); }
  @Post('copy-month') @HttpCode(201) @RequirePermission('engagement:manage_banners')
  copy(@CurrentUser() u: JwtPayload, @Body() dto: CopyMonthDto) { return this.svc.copyMonth(u, dto); }
  @Post() @HttpCode(201)    @RequirePermission('engagement:manage_banners')
  create(@CurrentUser() u: JwtPayload, @Body() dto: CreateOfferTileDto) { return this.svc.create(u, dto); }
  @Patch(':id')             @RequirePermission('engagement:manage_banners')
  update(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: UpdateOfferTileDto) { return this.svc.update(u, id, dto); }
  @Delete(':id')            @RequirePermission('engagement:manage_banners')
  remove(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.remove(u, id); }
}

@Controller('partner/offers')
@Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
export class PartnerOffersController {
  constructor(private readonly svc: OffersPartnerService) {}
  @Get() @RequirePermission('engagement:read')
  list(@CurrentUser() u: JwtPayload, @Headers('x-active-partner-id') active?: string) {
    return this.svc.listForPartner(u, active);
  }
}
```
Declare `copy-month` and `segment-options` **before** `:id` routes. Create
`api/src/offers/offers.module.ts` (imports `TenantModule` for `TenantSettingsService`; check how
`PartnerModule` imports it) and add `OffersModule` to `imports` in `api/src/app.module.ts` (~line 115).

**Test first** in `api/src/offers/offers.controller.spec.ts`, using the
`notification-templates.controller.spec.ts` style:
- `Reflector.get(ROLES_KEY, OffersAdminController)` equals `['GIFSY_ADMIN','CLIENT_ADMIN']`, and
  `Reflector.get(ROLES_KEY, PartnerOffersController)` equals the three partner roles.
- `PERMISSION_KEY` on each handler: reads are `engagement:read`, writes are `engagement:manage_banners`.
- Each handler delegates with `(user, …)`, and the partner handler forwards the header value.

### B7. Docs (BE lane)
- `platform/docs/plans/RESUME.md`: add a short "Offer tiles: built on `<branch>`, dormant, migration
  `20261109120000_add_offer_tiles`" entry under the current state.
- `platform/docs/plans/GO-LIVE-ISSUE-LIST.md`: add a tracker row.
- Mark this plan's status line once BE is merged.

### X1 (only if D1 = feature flag). `offerTiles` tenant feature, default OFF
Mirror `partnerDashboardV2` exactly:
- `api/src/gifsy/gifsy.service.ts` (lines 617, 762, 1014): add `offerTiles: !!features.offerTiles`.
- `platform/src/lib/platform/client-config.ts` (65): `offerTiles: boolean;`.
- `platform/src/lib/platform/default-client-config.ts` (53): `offerTiles: false,`.
- `platform/src/lib/tenant-features.ts` (65): `offerTiles: bool(f.offerTiles, d.offerTiles),`.
- Labels in `platform/src/app/gifsy/clients/new/page.tsx` (50, 68) and `[slug]/page.tsx` (34):
  `{ label: "This month's offers", description: 'Shows the Offers admin page so this tenant can publish offer tiles on the partner dashboard.' }`.
- Tests: extend the existing tenant-features normalizer test (grep `partnerDashboardV2` in
  `platform/src/lib/__tests__` and `api/src/gifsy/*.spec.ts`) with `offerTiles` default false and
  passthrough true.
- BE enforcement (recommended): in `OffersAdminService` write paths, 403 when the tenant's
  `features.offerTiles` is not true. Read it via `TenantService.resolveClient(clientId)`, the same
  source `/partner/me` uses (see `partner.service.ts` `resolveTenantFeatures`). The partner read
  stays data-driven and is **not** flag-gated.

---

## 6. FRONTEND LANE — tasks

Run vitest from `platform/`: `npx vitest run <path>`. Read `platform/AGENTS.md` first.

### F1. Types + formatters (`platform/src/lib/offers.ts`) — TDD
**Test first** in `platform/src/lib/__tests__/offers.test.ts`:
```ts
import { formatOfferValue, groupOffers, sectionValidTill, OFFER_GROUP_LABEL } from '@/lib/offers';

it('formats the big value', () => {
  expect(formatOfferValue({ valueType: 'POINTS', valueNumber: 35, valueText: null })).toBe('+35 pts');
  expect(formatOfferValue({ valueType: 'POINTS', valueNumber: 1, valueText: null })).toBe('+1 pt');
  expect(formatOfferValue({ valueType: 'PERCENT', valueNumber: 2.5, valueText: null })).toBe('+2.5%');
  expect(formatOfferValue({ valueType: 'RUPEES', valueNumber: 1500, valueText: null })).toBe('₹1,500');
  expect(formatOfferValue({ valueType: 'TEXT', valueNumber: null, valueText: 'Free kit' })).toBe('Free kit');
});
it('groups in fixed order and drops empty groups', () => {
  const g = groupOffers([tile('EXTRA_SCHEME'), tile('TARGET_REWARD')]);
  expect(g.map((x) => x.group)).toEqual(['TARGET_REWARD', 'EXTRA_SCHEME']);
  expect(groupOffers([tile('EXTRA_SCHEME')]).map((x) => x.group)).toEqual(['EXTRA_SCHEME']);
});
it('section "Valid till" only when all tiles share validTo', () => {
  expect(sectionValidTill([t('2026-11-30'), t('2026-11-30')])).toBe('30 Nov 2026');
  expect(sectionValidTill([t('2026-11-30'), t('2026-11-15')])).toBeNull();
});
```
**Implement:** the §3.1 types (copied verbatim) plus:
```ts
export const OFFER_GROUP_LABEL = { TARGET_REWARD: 'Earn on your targets', EXTRA_SCHEME: 'Extra schemes this month' } as const;
const num = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
export function formatOfferValue(t: Pick<OfferTilePartner, 'valueType' | 'valueNumber' | 'valueText'>): string {
  switch (t.valueType) {
    case 'POINTS':  return `+${num(t.valueNumber ?? 0)} ${t.valueNumber === 1 ? 'pt' : 'pts'}`;
    case 'PERCENT': return `+${num(t.valueNumber ?? 0)}%`;
    case 'RUPEES':  return `₹${num(t.valueNumber ?? 0)}`;
    default:        return t.valueText ?? '';
  }
}
/** 'YYYY-MM-DD' → '30 Nov 2026'. Pure string math — no Date/TZ, so it is hydration-safe. */
export function formatOfferDay(day: string): string { /* split + month-name table */ }
export async function fetchPartnerOffers(): Promise<OfferTilePartner[]> {
  const r = await api.get<{ tiles: OfferTilePartner[] }>('/api/partner/offers');
  return r.success && Array.isArray(r.data?.tiles) ? r.data.tiles : [];
}
// + admin fetchers: listOffers(month), getSegmentOptions(), createOffer, updateOffer, deleteOffer, copyMonth
```

### F2. Partner section component (`platform/src/components/partner/offers/offers-section.tsx`) — TDD
**Test first** in `platform/src/components/partner/offers/__tests__/offers-section.test.tsx` (mock
`@/lib/offers` `fetchPartnerOffers`):
1. **Renders nothing** when the fetch resolves `[]`: `container.firstChild` is null after
   `await waitFor(...)`.
2. **Renders nothing** when the fetch rejects. No error text is shown.
3. **First render is empty, before any data** (hydration guard): render, assert
   `container.innerHTML === ''` synchronously, *then* await the data.
4. With 3 tiles across both groups: it renders the heading "This month's offers", both group labels
   in order, a 2-column grid (`data-testid="offers-grid-TARGET_REWARD"` has class `grid-cols-2`),
   value first (`+35 pts`), then product and label.
5. A KPI-linked tile with `pct: 60` shows a progressbar `role="progressbar"` with
   `aria-valuenow=60`. With `unlocked: true` it shows the text "Unlocked". With `target: null` it
   shows no bar.
6. Tapping a tile opens the sheet (`role="dialog"`) with label, value, product, details and
   "Valid till 30 Nov 2026". When `details` is null it shows no "Details" heading. Close works.
7. "Valid till" in the header appears when all tiles share `validTo`. Otherwise each tile shows a
   small "till 15 Nov".

**Implement** (structure):
```tsx
'use client';
export function OffersSection() {
  const [tiles, setTiles] = useState<OfferTilePartner[] | null>(null); // null on 1st render → SSR/CSR identical
  const [open, setOpen]   = useState<OfferTilePartner | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchPartnerOffers().then((t) => { if (!cancelled) setTiles(t); }).catch(() => { if (!cancelled) setTiles([]); });
    return () => { cancelled = true; };
  }, []);
  if (!tiles || tiles.length === 0) return null;      // dormant ⇒ zero DOM for Deoleo
  const validTill = sectionValidTill(tiles);
  return (
    <section data-testid="offers-section" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-gray-900">This month&apos;s offers</h2>
        {validTill && <span className="text-[11px] text-gray-400">Valid till {validTill}</span>}
      </div>
      {groupOffers(tiles).map(({ group, tiles: gt }) => (
        <div key={group} className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{OFFER_GROUP_LABEL[group]}</p>
          <div data-testid={`offers-grid-${group}`} className="grid grid-cols-2 gap-2">
            {gt.map((t) => <OfferTileCard key={t.id} tile={t} showValidTo={!validTill} onOpen={() => setOpen(t)} />)}
          </div>
        </div>
      ))}
      <OfferSheet tile={open} onClose={() => setOpen(null)} />
    </section>
  );
}
```
- `OfferTileCard` is a `<button type="button">` (so it is keyboard and screen-reader accessible).
  Its contents are the big value
  (`text-2xl font-extrabold text-[var(--brand-primary)]`), `unitLabel` (small), `product`
  (semibold, truncate) and `label` (muted, `line-clamp-2`). If `progress?.target` is set, it shows a
  thin bar that reuses `pctBarColor` from `@/lib/targets` (as `TargetAchievementCard` does, page.tsx
  line 514) and `"{pct}%"`, or an emerald "Unlocked ✓" pill when `unlocked`.
- `OfferSheet` reuses `Modal` from `@/components/ui/modal` with a bottom-sheet override:
  `className="top-auto bottom-0 left-0 right-0 translate-x-0 translate-y-0 max-w-none rounded-b-none sm:left-1/2 sm:-translate-x-1/2 sm:max-w-lg"`.
  Radix provides the focus trap and Esc. The body holds the value, product, label, progress line
  ("120 / 200 cases · 60%"), `details` rendered with `whitespace-pre-line` (plain text only, **never**
  `dangerouslySetInnerHTML`) and "Valid till …". Add a footer note in English:
  "Offer details are for information. Rewards are credited as per programme terms."
  Let the owner tune the copy (D5).
- **No `localStorage`, no `new Date()` in render.** All date strings come from the server's
  `YYYY-MM-DD` via `formatOfferDay`.

### F3. Wire into the partner dashboard (both variants)
- **Modify** `platform/src/app/partner/dashboard/page.tsx`: import `OffersSection` and insert it right
  after line 1136:
  ```tsx
  {v2 && <TargetAchievementCard aggKpis={aggKpis} />}

  {/* ── 2c. THIS MONTH'S OFFERS — BOTH variants, ONLY when offerTiles is ON (shipped: flag OFF ⇒
         not mounted, zero requests). Self-fetching, self-hiding. ── */}
  {offersOn && <OffersSection />}   // offersOn = !!identity.features?.offerTiles
  ```
- **Tests first:** add to `partner-dashboard-v2.test.tsx`, or a new `offers-placement.test.tsx` with
  the same mocks, plus `vi.mock('@/lib/offers', ...)`:
  - v2=ON with tiles: `offers-section` comes **after** `target-achievement-card` in DOM order
    (`compareDocumentPosition`).
  - v2=OFF with tiles: `offers-section` is present, after the chart and before quick actions.
  - Either variant with `[]`: `queryByTestId('offers-section')` is null.
- Then run the **whole** dashboard test folder. Existing tests stub `global.fetch` per URL. Because
  `fetchPartnerOffers` swallows bad shapes into `[]`, they should stay green. If one asserts total
  fetch counts, add `vi.mock('@/components/partner/offers/offers-section', () => ({ OffersSection: () => null }))`
  to that file rather than loosening the assertion.

### F4. Admin page `/admin/offers`
Files:
- `platform/src/app/admin/offers/layout.tsx`: a copy of `notification-delivery/layout.tsx`
  (`allowedRoles={['GIFSY_ADMIN','CLIENT_ADMIN']}`).
- `platform/src/app/admin/offers/page.tsx`: a client page.
- `platform/src/app/admin/offers/_components/offer-form.tsx`: the create/edit form in a `Modal`.

Behaviour:
- Header: "This month's offers". A month picker (`<input type="month">`) defaults to the current IST
  month. Compute it in `useEffect` with `istMonthKey(new Date())` from `@/lib/ist-date` to avoid
  render-time Date (hydration). Buttons are **New tile** and **Copy last month**.
- The list is grouped by group label, with one row per tile showing the value preview
  (`formatOfferValue`), product, label, the validity "1 Nov – 30 Nov", a targeting summary ("All
  outlets", or "Gold · WHOLESALER · Maharashtra"), the KPI name, a **Published/Draft** toggle
  (PATCH `isActive`), Edit and Delete (with a confirm modal, then DELETE).
- The form has: group (radio), value type (select), value (a number input for POINTS/PERCENT/RUPEES
  and a text input with maxLength 12 for TEXT), unit label, product, headline, details (textarea),
  valid from/to (`type="date"`, defaulting to the month bounds), sort order, and targeting
  multi-selects. Programs/zones/states come from `/api/admin/offers/segment-options` and outlet
  types from `/api/settings/outlet-types`, with `displayName ?? label`. The KPI select ("None" plus
  `/api/admin/kpis`) sits under a field label like "Show this outlet's progress on". A **live tile
  preview** reuses `OfferTileCard` from F2 with mock progress, so admins see exactly what partners
  see.
- "Copy last month" opens a confirm modal: "Copy N tiles from October 2026 into November 2026 as
  drafts?" On confirm it POSTs `copy-month` and toasts "Created X, skipped Y (already copied)".
- Error states: show the BE 400 message verbatim (for example "Assume a tenant to manage offers.").
  Empty state: "No offers for this month yet."
- **Tests first** in `platform/src/app/admin/offers/__tests__/offers-admin.test.tsx`, using the
  `notification-delivery.test.tsx` harness:
  1. The list renders tiles from the mocked GET with the correct month query param, and **never sends
     clientId**.
  2. Create: fill the form → `api.post('/api/admin/offers', body)` with the §3.3 body shape.
     `valueText` is null for POINTS.
  3. Switching the value type to TEXT swaps the input and nulls `valueNumber` in the body.
  4. Delete asks for confirmation, then calls `api.del('/api/admin/offers/<id>')`.
  5. Copy last month posts `{fromMonth, toMonth}` with the previous month computed relative to the
     picker. Test it with a **date-relative** month and never a hardcoded "2026-11".
  6. A 400 from the API shows its message.

### F5. Admin nav + GIFSY_STAFF route map
- `platform/src/app/admin/layout.tsx`: add to `ALL_NAV_ITEMS`, next to Banners (line 184):
  ```ts
  // This month's offers — per-tenant partner-dashboard offer tiles. GIFSY_ADMIN (assumed) + CLIENT_ADMIN
  // only (same two roles as the BE @Roles + the admin/offers/layout.tsx guard).
  { href: '/admin/offers', label: "This Month's Offers", icon: BadgePercent, featureFlag: null /* or 'offerTiles' if D1=flag */, offersAdmin: true },
  ```
  Add the filter clause next to `deliveryReport` (line 259):
  `if ((item as { offersAdmin?: boolean }).offersAdmin && adminSession.role !== 'GIFSY_ADMIN' && adminSession.role !== 'CLIENT_ADMIN') return false;`.
  Import `BadgePercent` from `lucide-react` (verified: the installed version exports it).
- `platform/src/lib/rbac/route-permissions.ts`: `'/admin/offers': 'engagement:read',`.
- Tests: grep `platform/src/app/admin/__tests__` and `platform/src/lib/rbac/__tests__` for nav and
  route-map tests. Add a case that `/admin/offers` is shown to CLIENT_ADMIN, hidden from MIS_USER and
  GIFSY_STAFF, and maps to `engagement:read`.

### F6. Operator docs
Add a short "This month's offers" guide entry in the Help & Guides content (`platform/src/app/admin/guides/`;
find where existing guide slugs are defined). It covers what tiles are, that they are display-only,
targeting, KPI progress, and copy-last-month creating drafts.

---

## 7. Integration (after both lanes are green)
1. Merge both lanes on the feature branch. Run `npx prisma generate` (api), then
   **`bash scripts/gates.sh`** (full). Read the `GATES:` line and the exit code.
2. Local runtime check: api on :4000 and platform dev, with migration applied to `gifsy_dev`.
   - As CLIENT_ADMIN of a test tenant, create 1 TARGET_REWARD POINTS tile linked to the primary KPI
     and 1 EXTRA_SCHEME PERCENT tile.
   - As a partner of that tenant (FIXED_OTP locally), check that the section renders below Target
     Achievement (v2 tenant) or below the chart (non-v2 tenant), that the progress % equals the
     Target Achievement card row for that KPI, and that the sheet opens.
   - Check the browser console for **no React #418**.
3. Independent adversarial audit (WAYS #5): a fresh sub-agent with the BE + FE diff. Lanes:
   tenant isolation (cross-tenant id on PATCH/DELETE, forged `x-active-partner-id`, un-assumed
   owner), segment matching, KPI sum correctness, IST boundary (00:00–05:30 IST on the 1st and the
   last day), hydration, and **a UI/UX lane** (empty/error/loading states, copy honesty: it must
   never imply automatic crediting, a11y of tile buttons/sheet, 320 px width).

---

## 8. Risks
| Risk | Mitigation |
|---|---|
| Tile copy implies a promise ("+35 pts") that the programme doesn't credit | Display-only by design. Admin-authored copy plus a footer disclaimer in the sheet (D5). Nothing reads `offer_tiles` in any money path; the audit verifies with `grep -r offerTile api/src` → only `src/offers`. |
| Wrong tenant data (un-assumed GIFSY_ADMIN writes under `gifsy`) | `assertTenant` gives 400. Every query has `clientId: user.clientId`. Unit tests B4.2 and B4.5. |
| A forged active-outlet header shows another outlet's progress | `resolveActivePartnerId` re-authorizes (B5.2). |
| IST off-by-one (offer disappears early or late) | `@db.Date` + `istDateKey(now)`. Helper round-trip test. Staging check at the IST day boundary (§10). |
| Progress disagrees with the Target Achievement card | Same sources (OutletTarget/OutletSalesRecord, current IST month, null→0 sum). One difference: offers sum only over **segment-matching** outlets, while the card sums all of the partner's outlets. For single-outlet partners (the norm) they are identical. Documented in D4. |
| Hydration error on the partner shell (#58 class) | `tiles` starts null, the fetch runs in `useEffect`, no Date/localStorage in render. F2 test 3. |
| Extra request on every partner dashboard load (Deoleo included) | One indexed query (`clientId, deletedAt, validFrom, validTo`) that returns 0 rows and exits early. Acceptable, and noted in §9. |
| Migration on the shared staging/prod DB | Additive only (new types + new table). It is applied by the standard migrate job. No backfill. |
| Existing dashboard tests break on the new fetch | `fetchPartnerOffers` coerces a bad shape to `[]`. Mock the section where counts are asserted (F3). |

## 9. Deoleo byte-identical guarantee
- **Partner dashboard:** with `offerTiles` OFF (Deoleo), `<OffersSection/>` is **never mounted** and
  **no** offers request is made — the DOM and network are identical. (The partner API also returns
  `tiles: []` when the flag is OFF.)
- **Schema:** purely additive (2 enums + 1 table). No existing column, default or index changes.
- **Backend:** the new module adds routes only. No existing service, guard or query is modified.
  `app.module.ts` gains one import.
- **Admin nav:** ⚠️ **without D1 = flag, Deoleo's CLIENT_ADMIN sees a new "This Month's Offers" nav
  item.** With D1 = flag (`offerTiles` default OFF), the admin nav is identical too.
- **Sales app:** untouched.

## 10. Staging verification checklist (after the owner OKs a push to `develop`)
- [ ] Deploy actually served. Check the staging revision SHA (pushed ≠ deployed; a RED suite skips
      the deploy).
- [ ] Migration applied: the `offer_tiles` table exists in `gifsy_staging`, verified with a
      `current_database()`-guarded read.
- [ ] **Deoleo partner** (staging): dashboard unchanged, no "This month's offers", console has no
      #418, `/api/partner/offers` → `{tiles:[]}`.
- [ ] **Deoleo admin**: nav unchanged (D1 = flag) or the new item is visible (D1 = no flag), as
      decided.
- [ ] **Bajaj (v2)** as CLIENT_ADMIN (or GIFSY_ADMIN assumed into Bajaj; flag ON if D1): create a
      KPI-linked POINTS tile + a TEXT tile + a PERCENT EXTRA_SCHEME tile targeted at one program.
- [ ] Bajaj partner **in** that program: the section shows below Target Achievement, 2 groups,
      2-column grid, values `+35 pts` / `+2.5%` / text, progress % equals the Target Achievement row,
      the sheet opens and closes, and it works at 360 px width.
- [ ] A Bajaj partner **outside** the program sees no targeted tile (section absent if none apply).
- [ ] An outlet at ≥100% of the linked KPI shows "Unlocked".
- [ ] Draft (`isActive=false`) tile is not shown to the partner. Publish toggle shows it.
- [ ] Expired tile (validTo = yesterday IST) is not shown, and a future tile is not shown.
- [ ] Copy last month: creates drafts. Running it a second time gives `created 0, skipped N`.
- [ ] Delete: the tile disappears for the partner and the `audit_logs` row exists (`entityType='OFFER_TILE'`).
- [ ] Un-assumed GIFSY_ADMIN calling `GET /api/admin/offers?month=…` gets 400 with the message.
- [ ] MIS_USER / GIFSY_STAFF have no nav item. A direct URL gives access denied, and the API gives 403.
- [ ] A non-v2 tenant with a tile: the section renders below the chart, above Quick actions.
- [ ] Sales app dashboard unchanged.

## 11. Out of scope
- Any crediting, computing or reserving of points/₹ from tiles. Any link to the Points Compute
  Engine or PointsRule.
- Images, icons, rich text/markdown or links in tiles. Translations (English only).
- Per-outlet tile values. Outlet-level targeting by code list. Distributor/beat/metro/programCategory
  targeting (addable later as more arrays).
- Showing tiles in the sales app, notifications or push about new offers, analytics/impression
  tracking.
- Seed data in `prisma/seed.ts` (deliberately avoided because of the Docker seed-compile trap).
- Bulk upload of tiles via Excel.
- Per-tile publish scheduling beyond validFrom/validTo.

## 12. Open decisions for the owner (could not be resolved from code)
- **D1. Admin nav dormancy.** Without a flag, every tenant's CLIENT_ADMIN (incl. Deoleo) sees the new
  "This Month's Offers" admin item right away. *Recommendation:* add an `offerTiles` tenant feature
  (default OFF, task X1). That mirrors `partnerDashboardV2`, and the feature is then dormant
  everywhere until Gifsy turns it on per tenant. The partner side stays data-driven either way.
- **D2. Permission key.** Writes reuse `engagement:manage_banners` (same GIFSY_ADMIN + CLIENT_ADMIN
  binding as banners), so no new RBAC key and no seed-role change are needed. *Alternative:* a new
  `engagement:manage_offers` key, which needs `permissions.ts`, the role map in
  `api/src/common/rbac/can.ts`, the GIFSY seed roles and reserved-permission specs. Recommend reuse.
- **D3. Publish toggle + copies as drafts.** The spec has no publish state. I added `isActive`
  (default true on create) so that "Copy last month" does not instantly publish last month's values
  to partners. *Recommendation:* keep it. The alternative is copies going live immediately.
- **D4. Multi-outlet partners.** Progress sums only the partner's outlets that match the tile's
  segment. A tile applies if **any** of the partner's active outlets match. Confirm, or choose "use
  the primary outlet only".
- **D5. Disclaimer copy** in the bottom sheet ("Offer details are for information. Rewards are
  credited as per programme terms."). The owner should confirm the wording.
- **D6. Loyalty-disabled outlet types.** Tiles currently ignore `OutletTypeClientConfig.loyaltyEnabled`.
  Admins control audience via `outletTypeCodes`. Should points-type tiles be auto-hidden for
  outlet types with loyalty OFF? *Recommendation:* no (YAGNI; targeting covers it).
- **D7. Empty targeting = everyone.** The spec calls program and outlet type "targeting" and
  zone/state "optional". I made all four optional (empty = all). Should program/outlet type be
  required in the form?
