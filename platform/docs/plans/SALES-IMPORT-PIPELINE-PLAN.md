# Sales Import Pipeline — Implementation Plan (DMS invoice-line file → monthly KPI achievements)

> **Status (2026-11-16): ✅ LIVE ON PROD** — shipped with #59 (`a18cc932`, 2026-11-12); FOCUS-FROM-TARGETS + the
> PRODUCT_COUNT ("LINES") measure shipped in `e242b1a1`; prod serves `2eb8271d`. Prod infra exists (§14). `salesImport`
> is ON for Bajaj; **November 2026 applied on prod 2026-11-15 and verified per outlet (6,452 records); the month is OPEN**
> (points rules for November pending a dedicated rule-engine session — do not close the month or compute points before
> then). **Read §18 (traps learned on the prod November apply) before configuring KPIs or uploading targets.**
>
> _(Historical status 2026-11-11 follows.)_ **P0–P3 COMPLETE · P4 STAGING DONE — LIVE on staging since develop `7c85d9fd` (2026-11-11), NOT on prod (at that date).**
> Shipped to staging as part of one release with batch #59 (+ Bajaj prod config screens, branding/routing fixes, per-user rate limits,
> OTP hardening); the owner releases it to prod TOGETHER with #59. Includes the extras (§10c): month history product-list summary +
> **"Rebuild product list"**, KPI picker from month history, reprocess-as-new, graceful worker stop (SIGTERM, exit 143), and the runner
> safety net (`salesImport` can't be switched ON where `SALES_IMPORT_RUNNER` isn't configured). Staging infra CREATED (§14). **Staging
> run on the REAL DMS file (2026-11-11):** 214.7 MB in 52 parts through the real UI pipeline → the job started <1 s after complete, ran
> 8 m 28 s → READY import `6b681de7-1495-4129-9471-0fdc73a58e3b`: 635,427 rows (1 skipped); Oct ₹586,716,492.12 / 170,312.546 cases
> (per-outlet 3-dp rounding; raw 170,312.543); Nov ₹34,439,896.87 / 10,085.335 cases (raw 10,085.354); Oct matched 4,874 outlets
> ₹136,984,266.33. **NOT applied** — apply is blocked until bajaj importer-owned KPIs exist (owner supplies D-8/D-9, §17). Drain endpoint
> 403 without the secret, 200 from the Scheduler. Local real-file proof (throwaway Postgres) was exact to the paisa vs an independent
> calculation; the scratchpad copies of the file are deleted. **Prod:** infra NOT created — separate owner OK at release (§14); until
> then the API refuses to switch `salesImport` ON in prod. Owner approved (2026-11-10, platform-wide) the upload guard on logout /
> brand-switch / exit-tenant / log-out-all-devices (force mode, 5 s timeout). **Read §10a first** for deviations and file ownership.
> Owner decisions (final): D-1 = A (guard), D-3 = A (`exceljs`), D-4 = A (Cloud Run Job), D-5 = A (reuse `targets:*`).
> **Classification:** ⚠️ **PLATFORM-WIDE but TENANT-GATED.** The owner approved it as such: new shared module + schema +
> two small, data-gated edits to the shared manual achievement upload. It is dormant for every tenant until the
> per-tenant flag `salesImport` is ON *and* the tenant has importer-owned KPIs. **Deoleo stays byte-identical** (§12).
> **Audience:** an engineer with ZERO context. Every existing piece reused is cited `file:line` (paths relative to
> repo root `C:\Users\nikun\Loyaltybaseclaude`). Read §1–§5 before picking up a lane task.

---

## 0. TL;DR

An admin uploads the tenant's DMS "sales invoice detail" export (xlsx or CSV, ~635k rows, ~200 MB), one row per
invoice line. The file goes to GCS in 4 MiB chunks through the API. A background worker streams it once and builds
per-(month × outlet × product-attribute) aggregates. The admin gets a per-month PREVIEW, ticks the OPEN months to
apply, and each ticked month's importer-owned KPI values in the EXISTING achievement store (`OutletSalesRecord.kpiValues`)
are **fully rewritten** in one transaction per month. Months get closed by an admin and only GIFSY can reopen them.
The EXISTING Points Compute Engine then computes points for CLOSED months, unchanged except for one optional, isolated
guard that needs an owner decision (D-1). The importer credits nothing.

---

## 1. Generic design and the existing platform (owner requirements, binding)

| # | Owner requirement | How this plan satisfies it |
|---|---|---|
| G1 | **No change to Points Compute Engine code or semantics.** The importer is only a new DATA SOURCE. | The importer writes numbers under `KpiDef.code` keys into `OutletSalesRecord.kpiValues`. The engine already loads that per (clientId, month) (`api/src/points-engine/points-compute.service.ts:144-147`) and passes the WHOLE achievements and targets maps to the evaluator (`:247-253`), so a rule can read any KPI. Zero edits to the evaluator, rule store or compute service. **One isolated, optional exception** (an HTTP guard so export/commit refuse an OPEN month) is decision **D-1** for the owner. The plan works without it (Option B). |
| G2 | Manual target/achievement upload, credits upload and wallets stay unchanged and remain the default. | Targets upload is untouched. Credits and wallets are untouched. The manual achievement upload gets one data-gated branch: it runs only when the tenant has ≥1 importer-owned KPI (§7.4). With zero owned KPIs (every tenant today, incl. Deoleo) the code path is the existing one, byte for byte. |
| G3 | **Generic importer.** Per-tenant COLUMN MAPPING config. No Bajaj column names or KPI names in code. | `SalesImportProfile.columnMapping` (per tenant) names the headers for outlet code, invoice date, amount, quantity and N free-form **dimensions** (e.g. `brand`←"CODE", `skuGroup`←"CLUB SKU"). Header-row detection is configurable (auto-scan or a fixed row). KPI definitions (`SalesKpiDefinition`) are per-tenant config: a filter on any mapped dimension(s) plus measure AMOUNT or QUANTITY. Bajaj values exist only as admin-entered data (Appendix A), never in code. Code and tests use neutral fixtures (`dimA`, `dimB`, `KPI_X`). |
| G4 | **Per-KPI source ownership.** Each KPI is fed by the importer OR the manual upload, never both. | A KPI is **importer-owned** iff an enabled `SalesKpiDefinition` exists for `(clientId, kpiCode)`. The importer writes ONLY owned keys and strips/rewrites only those (SQL `kpiValues - owned::text[] || new`). The manual achievement upload drops owned-KPI columns with a clear `skippedImporterOwnedKpis` message and preserves owned keys when it rewrites a row. Batch-delete never wipes owned keys (§7.4). Tenants can mix both sources freely. |
| G5 | **Honest limit.** | Supports **"one row per invoice line" (long/tidy) files only**: one header row and one line per row, with an outlet code, a date, an amount and/or quantity, plus attribute columns. Pivoted/wide files (one column per month or per brand), multi-sheet merges, or files with subtotal rows mixed in **are not supported**. Those keep using the manual achievement upload. The UI says this on the upload screen. |

**What already exists and is reused (do not rebuild):**

| Existing piece | Where | Reused for |
|---|---|---|
| Achievement store `OutletSalesRecord` (`kpiValues Json` = jsonb, `@@unique([clientId, outletCode, month])`, required `batchId` FK → `SalesUploadBatch`, cascade) | `api/prisma/schema.prisma:2903-2943`; DDL `api/prisma/migrations/00000000000000_baseline/migration.sql:1361` (camelCase quoted columns) | Output store (no schema change) |
| `KpiDef` (`code`, `unit`, `outletType`, `enabled`) | `schema.prisma:2951-2983` | Importer KPIs MUST be enabled KpiDef codes so dashboards, My Targets and the engine's publish-time reconcile (`points-engine.service.ts:375-390`) see them |
| Consumers that read `kpiValues` by KPI code (no change needed) | `targets.service.ts:418,920` (getPace), `partner.service.ts:413,554` (My Targets / target card), `group.service.ts:267`, `sales.service.ts:1408,1556,1619,2013,2059`, `offers-partner.service.ts:115`, `program-health-dashboard.service.ts:291`, `points-compute.service.ts:144` | Pick up importer values automatically |
| Manual achievement upload (REPLACES the whole `kpiValues` per row: `update: { kpiValues: kpiMap }`) | `api/src/targets/targets.service.ts:714-841` (upsert at `:805-823`); delete-batch cascade `:862-870` | Gets the data-gated ownership branch (§7.4) |
| Engine input join (full maps → evaluator), `pct:<kpi>` derived source (achievement ÷ target × 100) | `points-compute.service.ts:127-253`; `points-engine.helper.ts:124-151` (pct at `:137-145`) | ₹-gate + cases-measure in one rule (§9) |
| Engine formula whitelist incl. `floor` | `points-engine.helper.ts:750` | `floor(cases) × rate` |
| Engine controllers / permissions | `points-compute.controller.ts:37-141` (`points_rules:read`, commit `credits:upload`) | Unchanged (D-1 adds a guard decorator only if approved) |
| Storage: `uploadFile` (non-resumable save), private bucket, signed URLs **known-broken on Cloud Run** | `api/src/storage/storage.service.ts:53-79`, `:76-79` comment; `api/src/kyc/kyc.service.ts:5908-5913` "KNOWN RESIDUAL… getSignedUrl fails on Cloud Run" | Chunk parts written with `uploadFile`; worker streams via `bucket.file().createReadStream()` |
| Body limit 25 MB (API), Cloud Run 32 MB request cap, multipart pattern via `FileInterceptor` (10 MB today) | `api/src/main.ts:39,48`; `targets.controller.ts:278-297` | 4 MiB chunk uploads |
| Cloud Run API = 512Mi / 1 CPU / `--cpu-throttling` / min 0 | `.github/workflows/deploy-staging.yml:122-133`; prod `deploy.yml:144-155` | ⇒ no in-process background work (see the throttling notes at `kyc.controller.ts:222`, `push.controller.ts:67`) |
| In-VPC Cloud Run **Job** pattern (same image, `--command`/`--args`, VPC + Cloud SQL + SA) | `deploy-staging.yml:98-109` (`gifsy-migrate-staging`) | The import worker job |
| Secret-gated, fail-closed `@Public` drain endpoint | `whatsapp-ops.controller.ts:56-67`; `kyc.controller.ts:215-245` | Fallback kick for stuck imports |
| Per-tenant feature flag pattern (`features.offerTiles`, default OFF, fail-closed) | BE gate `offers-admin.service.ts:130-139`; console projections `gifsy.service.ts:619,765,1018`; DTO merge `gifsy/dto/gifsy.dto.ts:147-151`; FE `platform/src/lib/platform/client-config.ts:79`, `default-client-config.ts:55`, `lib/tenant-features.ts:67`; nav `app/admin/layout.tsx:189,277-278`; console labels `app/gifsy/clients/[slug]/page.tsx:36`, `clients/new/page.tsx:47,66` | `features.salesImport` |
| Permissions `targets:read/upload/manage_config` (role floor `@Roles('CLIENT_ADMIN','GIFSY_ADMIN')`) | `api/src/common/rbac/permissions.ts:139-142`; guard semantics `common/guards/permission.guard.ts:24-28` | Same keys (D-5) |
| Un-assumed operator → 400 pattern | `offers-admin.service.ts:130-135` | All write endpoints |
| AuditLog (no clientId column → put it in `metadata`; actions `CREATE/UPDATE/DELETE/IMPORT…`) | `schema.prisma:56-66, 759-782`; in-tx write example `admin-core.service.ts:639-647` | apply/close/reopen/config audit |
| IST helpers | `api/src/common/ist-date.ts:123` (`istMonthKey`), `:161` (`istMonthBounds`); `targets.helpers.ts:134-162` (`currentMonthKey`, `isMonthLocked`) | Month keys and open/closed resolution |
| Advisory xact lock idiom | `common/partner-group.helper.ts:548`, `common/reward-account.helper.ts:26` | Per (client, month) apply/close serialization |
| `xlsx` (SheetJS 0.18.5) is the ONLY spreadsheet dep; **no streaming reader** | `api/package.json` deps | Test-fixture writing only (D-3) |

---

## 2. Decisions the code could not settle (owner)

Each item has a recommendation. Lanes build the recommended option unless the owner says otherwise. Only D-1 and D-4
change things outside the new module.

| ID | Decision | Options | Recommendation and why |
|---|---|---|---|
| **D-1** | Engine guard: refuse points compute for an OPEN month? | **A** Add `@UseGuards(SalesMonthClosedGuard)` to 4 routes of `points-compute.controller.ts` (`export` `:79`, `commit` `:54`, `preview-report` `:105`, `payout-report` `:127`). Preview stays allowed (read-only, useful mid-month). Guard is a no-op unless `features.salesImport === true`. It returns 409 "May 2026 is still OPEN. Close it in Sales Import first." **B** No engine change. Rely on process and on the Close button. **C** Warn only (needs a preview response-shape change, so it is an engine change). | **A.** The export and report are what the client approves offline. If they are generated on a month that can still be rewritten, the approved points and the stored achievements can silently diverge. That breaks money trust. A is 4 decorator lines plus one import. It does not touch the evaluator, rule store, compute service or response shapes, and it is inert for every tenant without the flag. It is still an edit to an engine file, so per G1 the owner must say yes. If the answer is no, lanes ship B and the FE shows "Month is OPEN; numbers may still change" on the Sales Import month screen only. |
| **D-2** | Large-file transport | **A (rec.)** Browser slices the file into 4 MiB parts → `POST /admin/sales-import/:id/parts/:n` (multipart, same as `targets.controller.ts:281-289`) → API `uploadFile` to `sales-imports/<clientId>/<importId>/parts/<n>` → worker streams parts in order as one stream. **B** Browser PUTs directly to a GCS **resumable session URI** created server-side (`file.createResumableUpload({origin})`, needs no signing). This needs bucket CORS for the exact tenant origins with `Range` exposed. The current CORS is `https://*.gifsy.in` with headers `Content-Type, x-goog-resumable` (`terraform/gcs-memorystore.tf:12-24`); GCS CORS may not honour that sub-domain wildcard, which is unverified. **C** V4 signed PUT URL: rejected, signing is known-broken on Cloud Run here (`storage.service.ts:76-79`). | **A.** No infra, CORS or signing dependency, and it uses only proven paths (multipart through the Next proxy and `uploadFile`). 200 MB ≈ 50 requests ≈ 1–3 min. Each part is retried idempotently (same `n` overwrites). B is faster but has two unverified infra premises (WAYS #11). Keep it as a later optimisation behind the same FE `uploadInParts()` abstraction. |
| **D-3** | New dependency `exceljs` (streaming xlsx reader) | **A (rec.)** Add `exceljs` to `api/package.json` **dependencies** (in package.json + lockfile, imported only by the worker parser). **B** CSV-only: admin saves the DMS export as CSV (Excel handles 635k < 1,048,576 rows); the xlsx path is not built. | **A.** It is essential. SheetJS 0.18.5 (`xlsx`) loads the whole workbook: 635k × 76 cells ≈ 48M cells, many GB, so it cannot run in 2 GiB. `exceljs.stream.xlsx.WorkbookReader` streams rows. ⚠️ Per the delivery-status memory, an import missing from `package.json` builds green but **crashes at boot**. So the gate for Task I-0 asserts `require.resolve('exceljs')` inside the built runner image (`npm ci --omit=dev`). CSV is supported in both options with a hand-rolled RFC-4180 streaming parser (no dep). |
| **D-4** | Where the worker runs | **A (rec.)** A Cloud Run **Job** `gifsy-sales-import[-staging]`: same api image, `--command=node --args=--max-old-space-size=1700,dist/sales-import/worker.main.js`, 2Gi/1 CPU, task-timeout 3600s, max-retries 1, same VPC/SQL/SA flags as `deploy-staging.yml:98-109`. The API triggers it via the Cloud Run Admin REST `POST https://run.googleapis.com/v2/projects/{P}/locations/{R}/jobs/{J}:run` with a metadata-server token (built-in `fetch`, **no new dep**, no overrides). The job claims QUEUED imports itself (`FOR UPDATE SKIP LOCKED`). **Infra:** grant the api SA `roles/run.invoker` (contains `run.jobs.run`) on that job, plus a deploy step in `deploy-staging.yml` / `deploy.yml`. **B** Raise the API service to 2Gi + `--timeout=3600` + no CPU throttling and process inside a held request. This changes the live API service for every tenant (cost, blast radius). **C** Request-driven chunk processing on the 512Mi API. xlsx (a zip) can't be resumed mid-stream, so CSV only. | **A.** It is isolated (a crash or OOM can't take down Deoleo's API) and sized for the job. It follows the proven migrate-job pattern. Infra is an IAM binding plus a deploy step, so the owner must approve, as with any deploy-workflow change. Local dev and tests use `SALES_IMPORT_RUNNER=inline` (in-process). IAM checked in Phase 0 (§10a.5): `roles/run.invoker` (or the narrower `roles/run.jobsExecutor`) covers `jobs:run` WITHOUT overrides; WITH overrides it needs `roles/run.jobsExecutorWithOverrides` (`run.jobs.runWithOverrides`). |
| **D-5** | Permissions | **A (rec.)** Reuse `targets:read` (view), `targets:upload` (upload/process/apply/close), `targets:manage_config` (mapping + KPI definitions). **Reopen = `@Roles('GIFSY_ADMIN')` + assumed tenant.** **B** New `sales_import:*` keys (catalog + seed-roles + reserved list changes = more platform-wide surface). | **A.** These are exactly the keys guarding the manual achievement upload (`targets.controller.ts:278-280`) and KPI config (`:80-110`). "Mirror existing upload permissions" says the same. |
| D-6 | Should the manual achievement upload respect month close for NON-owned KPIs? | Leave it as today (it does not) / lock it too | **Leave it as today.** Close applies to importer data. Otherwise G2 is violated. (Owner may revisit.) |
| D-7 | Negative monthly KPI (returns > sales) | store as-is / clamp 0 | **Store as-is** (honest data). The engine's gate (`pct ≥ 100`) or `floor`/`cap` handles it. The preview flags outlets with negative values. |
| D-8 | Bajaj rule numbers (points per case, cap) and outlet-type scope | client input | Placeholders `10` / `50000` in §9. The rule is admin-authored data, not code. |
| D-9 | Bajaj KPI codes on staging | verify | Staging has `MONTH TARGET` (₹, primary; targets and achievement backfilled `{"MONTH TARGET": v}`, BAJAJ-DATA-MIGRATION.md:166). `ADHO TARGET`, `NON ADHO`, `CNO 500`, `CNO 500 CASES`, `BSC CASES` probably need creating via the existing KPI config (`POST /v1/admin/kpis`, `targets.controller.ts:88`). Confirm names and units with the owner. Once `MONTH TARGET` is importer-owned, the backfilled historical months are untouched (unticked/closed months are never written). |

---

## 3. Architecture

```
Browser (admin, tenant host)                 API (Cloud Run svc, 512Mi)                    Worker (Cloud Run JOB, 2Gi)
─────────────────────────────                ─────────────────────────────                 ─────────────────────────────
1 POST /sales-import/uploads ──────────────▶ create SalesImport(UPLOADING) + parts plan
2 POST /:id/parts/:n  (4 MiB × ~50) ───────▶ storage.uploadFile(parts/<n>)  (idempotent)
3 POST /:id/complete ──────────────────────▶ verify Σpart sizes == declared → QUEUED
                                             runner.kick(): inline | Cloud Run jobs:run ─▶ claim QUEUED (SKIP LOCKED) → PROCESSING
4 GET  /:id  (poll 2s) ◀──────────────────── status/progress ◀──────── heartbeat 5s ──── stream parts → sha256 + rows
                                                                                       │ detect header row / map columns
                                                                                       │ parse date→month, amount→paise,
                                                                                       │ qty→micro-cases, dims→normalized
                                                                                       │ roster match (Outlet.outletCode)
                                                                                       │ in-mem Map(month|outlet|dimKey)
                                                                                       ▼
                                                                         SalesImportAggregate rows (createMany 5k)
                                                                         month summaries, unmatched.csv → GCS → READY
5 GET  /:id/preview ───────────────────────▶ per month: KPI values from aggregates (keyset pages)
                                             × current defs, deltas vs OutletSalesRecord, open/closed,
                                             warnings, definitionsHash, rosterHash check
6 POST /:id/apply {months, expectedDefinitionsHash, acks} ─▶ per month ONE tx:
                                             advisory lock → re-check OPEN → SalesUploadBatch(SALES_IMPORT)
                                             → bulk INSERT…ON CONFLICT merge (owned keys only, zero-fill)
                                             → strip owned keys of off-roster rows → SalesImportApply
                                             → SalesMonthStatus.lastApplied → AuditLog
7 POST /sales-months/:m/close | /reopen (GIFSY) ─▶ lock/unlock + AuditLog
8 Points Compute Engine (unchanged) reads OutletSalesRecord for CLOSED month → preview → export/commit (D-1 guard)
```

**Volumes (design targets):** 635k lines → ≈ 6.5k matched outlets × ~2 months × ~15–40 dim combos ⇒ **≈ 100k–400k
aggregate rows per import** (worst case ~500k). Apply per month = ~6.5k outlets × ~6 KPIs ⇒ **one ~6.5k-row bulk upsert**
(2 statements of 3,250 rows with `unnest`), < 5 s, inside one transaction.

---

## 4. Data model (one additive migration, Lane-0)

Migration `api/prisma/migrations/20261110120000_add_sales_import/migration.sql` (plain additive `CREATE TABLE` +
indexes. String status columns, not Prisma enums, so the migration stays additive; same convention as
`KpiDef.rollup`, `schema.prisma:2961-2966`). Add the models after `OutletTarget` (`schema.prisma:3025`):

```prisma
// ─── MODULE: SALES IMPORT — DMS invoice-line file → importer-owned KPI achievements ───
// Dormant unless features.salesImport === true. See platform/docs/plans/SALES-IMPORT-PIPELINE-PLAN.md.

model SalesImportProfile {            // one per tenant: how to read THIS tenant's file
  id            String   @id @default(cuid())
  clientId      String   @unique
  columnMapping Json     // SalesColumnMapping (§6.1)
  updatedById   String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@map("sales_import_profiles")
}

model SalesKpiDefinition {            // existence + enabled ⇒ the KPI is IMPORTER-OWNED (G4)
  id          String   @id @default(cuid())
  clientId    String
  kpiCode     String   // MUST be an enabled KpiDef.code of this tenant (validated on save)
  measure     String   // 'AMOUNT' | 'QUANTITY'
  filter      Json     // SalesKpiFilter (§6.2)
  outletTypes String[] @default([])  // optional scope by Outlet.outletType.code; [] = all
  programs    String[] @default([])  // optional scope by Outlet.programName; [] = all
  enabled     Boolean  @default(true)
  order       Int      @default(0)
  updatedById String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([clientId, kpiCode])
  @@index([clientId])
  @@map("sales_kpi_definitions")
}

model SalesImport {
  id                 String    @id @default(cuid())
  clientId           String
  uploadedById       String
  originalFilename   String
  fileKind           String    // 'XLSX' | 'CSV'
  sizeBytes          BigInt
  partCount          Int
  partsReceived      Int       @default(0)
  gcsPrefix          String    // sales-imports/<clientId>/<id>/
  status             String    @default("UPLOADING") // UPLOADING|QUEUED|PROCESSING|NEEDS_MAPPING|READY|FAILED|CANCELLED
  contentSha256      String?
  duplicateOfId      String?   // earlier READY import with the same sha256 (same tenant)
  mappingSnapshot    Json?     // profile used for this run
  detectedHeaders    Json?     // first 10 rows' cells (NEEDS_MAPPING wizard)
  rosterHash         String?   // sha256 of sorted roster outletCodes at processing time
  bytesRead          BigInt    @default(0)
  rowsRead           Int       @default(0)
  rowsSkipped        Int       @default(0)
  errorSamples       Json?     // ≤ 200 {row, column, reason}
  monthSummaries     Json?     // MonthSummary[] (§6.3)
  dimensionValues    Json?     // {dimKey: [{value, lines, amountPaise}]} top 200 per dim, to help author filters
  dimensionCombos    Json?     // [{dims:{brand,skuGroup,…}, lines, amountPaise, qtyMicro}] ALL distinct full combos (≤ 2,000; sorted by |₹|) — the multi-combo picker (§6.2a)
  error              String?
  attempts           Int       @default(0)
  heartbeatAt        DateTime?
  startedAt          DateTime?
  finishedAt         DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  aggregates SalesImportAggregate[]
  applies    SalesImportApply[]
  @@index([clientId, createdAt])
  @@index([status])
  @@index([clientId, contentSha256])
  @@map("sales_imports")
}

model SalesImportAggregate {
  id          BigInt  @id @default(autoincrement())   // keyset pagination key
  importId    String
  month       String  // YYYY-MM (invoice calendar month)
  outletCode  String
  dims        Json    // {"dimA":"X","dimB":"500"} normalized (§6.1)
  dimKey      String  // stable JSON of dims (sorted keys)
  amountPaise BigInt  // Σ amount in paise (signed, returns net off)
  qtyMicro    BigInt  // Σ quantity × 1e6 (signed)
  lines       Int
  import SalesImport @relation(fields: [importId], references: [id], onDelete: Cascade)
  @@index([importId, month, id])
  @@map("sales_import_aggregates")
}

model SalesImportApply {              // immutable history of every apply (audit + "what was written")
  id                  String   @id @default(cuid())
  importId            String
  clientId            String
  month               String
  appliedById         String
  batchId             String   // the SalesUploadBatch(status 'SALES_IMPORT') created for this apply
  definitionsHash     String
  definitionsSnapshot Json     // frozen SalesKpiDefinition[] used
  outletsWritten      Int
  outletsZeroFilled   Int
  totals              Json     // {kpiCode: {before, after}}
  createdAt           DateTime @default(now())
  import SalesImport @relation(fields: [importId], references: [id], onDelete: Restrict)
  @@index([clientId, month, createdAt])
  @@map("sales_import_applies")
}

model SalesMonthStatus {              // explicit override of the implicit open/closed rule (§7.3)
  id                  String    @id @default(cuid())
  clientId            String
  month               String
  state               String    // 'OPEN' | 'CLOSED'
  closedAt            DateTime?
  closedById          String?
  reopenedAt          DateTime?
  reopenedById        String?
  lastAppliedImportId String?
  lastAppliedAt       DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  @@unique([clientId, month])
  @@map("sales_month_statuses")
}
```

**No change to `OutletSalesRecord` / `SalesUploadBatch` / `KpiDef`.** The importer's batch rows use
`SalesUploadBatch.status = 'SALES_IMPORT'` (the column is a free String, default `"COMPLETED"`, `schema.prisma:2911`).
⚠️ Run `npx prisma generate` before gating (memory: admin-user-phone-lifecycle).

---

## 5. API contract (lanes build against this; Lane-0 writes `api/src/sales-import/sales-import.contract.ts` and the FE mirror `platform/src/lib/sales-import/types.ts`)

All routes go under the backend `/v1` (FE calls `/api/...`; Next rewrites `/api/:path*` → `/v1/:path*`, `platform/next.config.ts:22-27`).
Envelope `ApiResponse<T>` (`platform/src/lib/api-client.ts:14`). Role floor `@Roles('CLIENT_ADMIN','GIFSY_ADMIN')`
unless stated. Every write: 400 for an un-assumed Gifsy operator, 403 when `features.salesImport !== true`
(re-read UNCACHED for writes, fail-closed). Tenant = `user.clientId`.

### 5.1 Types

```ts
export type SalesImportStatus =
  'UPLOADING'|'QUEUED'|'PROCESSING'|'NEEDS_MAPPING'|'READY'|'FAILED'|'CANCELLED';

export interface SalesColumnMapping {
  sheetName?: string | null;                 // xlsx only; null → first sheet
  headerRow: 'auto' | number;                // 'auto' = first row in rows 1..10 containing ALL mapped headers; number = 1-based
  outletCode: string;                        // header text (matched after normalizeHeader)
  outletName?: string | null;
  invoiceDate: string;
  amount?: string | null;                    // at least one of amount/quantity
  quantity?: string | null;
  dimensions: Array<{ key: string; label: string; header: string }>; // key: /^[a-z][a-zA-Z0-9]{0,23}$/, ≤ 6
  dateOrder: 'DMY' | 'MDY' | 'YMD';          // for TEXT dates only (real date cells are unambiguous)
}

export type SalesKpiMeasure = 'AMOUNT' | 'QUANTITY';
export type DimMatch = Record<string, string>;   // every listed dim must equal (normalized)
export interface SalesKpiFilter { anyOf?: DimMatch[]; noneOf?: DimMatch[] } // {} = all lines

export interface SalesKpiDefinitionDto {
  id?: string; kpiCode: string; measure: SalesKpiMeasure; filter: SalesKpiFilter;
  outletTypes: string[]; programs: string[]; enabled: boolean; order: number;
}

export interface SalesImportSummary {
  id: string; status: SalesImportStatus; originalFilename: string; fileKind: 'XLSX'|'CSV';
  sizeBytes: number; partCount: number; partsReceived: number;
  bytesRead: number; rowsRead: number; rowsSkipped: number;
  progressPct: number | null;                // bytesRead / sizeBytes while PROCESSING
  duplicateOfId: string | null; error: string | null;
  detectedHeaders: string[][] | null;        // NEEDS_MAPPING only
  createdAt: string; finishedAt: string | null; uploadedBy: string;
}

export interface MonthSummary {              // computed by the worker, frozen
  month: string; firstDate: string; lastDate: string; lines: number;
  matchedOutlets: number; unmatchedCustomers: number;
  matchedAmountRupees: number; matchedQuantity: number;
  unmatchedAmountRupees: number; unmatchedQuantity: number;
}

export interface MonthPreview extends MonthSummary {   // live, per GET
  monthState: 'OPEN' | 'CLOSED';
  canApply: boolean; blockedReason?: string;
  warnings: Array<'STARTS_AFTER_FIRST'|'ENDS_BEFORE_MONTH_END'|'OLDER_THAN_LAST_APPLIED'
                 |'REPLACES_MANUAL_VALUES'|'NEGATIVE_VALUES'|'ROSTER_CHANGED'>;
  zeroFillOutlets: number;                   // programme outlets with no lines → 0
  kpis: Array<{ kpiCode: string; label: string; measure: SalesKpiMeasure;
                newTotal: number; currentTotal: number; delta: number;
                outletsNonZero: number; outletsNegative: number }>;
  lastApplied: { importId: string; at: string; byName: string } | null;
}

export interface SalesImportPreview {
  importId: string; definitionsHash: string; rosterHashMatches: boolean;
  months: MonthPreview[];
}

export interface ApplyRequest {
  months: string[];                          // each must be OPEN + present in the file
  expectedDefinitionsHash: string;           // TOCTOU guard (409 on mismatch)
  acknowledgePartialMonths?: string[];       // required for months with STARTS_AFTER_FIRST/ENDS_BEFORE_MONTH_END
  acknowledgeOlderThanLastApplied?: boolean; // required if any month has OLDER_THAN_LAST_APPLIED
}
export interface ApplyResult {
  results: Array<{ month: string; ok: boolean; applyId?: string; outletsWritten?: number;
                   outletsZeroFilled?: number; error?: string }>;
}

export interface SalesMonthRow {
  month: string; state: 'OPEN'|'CLOSED'; implicit: boolean; // implicit = no override row
  closedAt: string|null; closedBy: string|null; lastAppliedAt: string|null; lastAppliedImportId: string|null;
  canClose: boolean; canReopen: boolean;
}
```

### 5.2 Routes

| Method & path (backend `/v1`) | Perm | Body / query → response |
|---|---|---|
| `GET  admin/sales-import/profile` | targets:read | → `SalesColumnMapping \| null` |
| `PUT  admin/sales-import/profile` | targets:manage_config | `SalesColumnMapping` → saved (validated: unique headers, dims keys unique, ≥1 of amount/quantity). Audit UPDATE |
| `GET  admin/sales-import/kpis` | targets:read | → `SalesKpiDefinitionDto[]` + `{definitionsHash}` |
| `POST admin/sales-import/kpis` | targets:manage_config | dto → created (409 if kpiCode already owned; 400 if not an enabled KpiDef; 400 if filter references an unmapped dim key). Audit CREATE |
| `PATCH admin/sales-import/kpis/:id` | targets:manage_config | partial dto → updated. Audit UPDATE (old/new) |
| `DELETE admin/sales-import/kpis/:id` | targets:manage_config | sets `enabled=false` (ownership released to the manual upload). Audit DELETE |
| `POST admin/sales-import/kpis/test` | targets:read | `{importId, definition}` → `{months:[{month,totalAmountRupees,totalQuantity,outletsNonZero}], unmatchedEntries, redundantEntries, matchedLines}` (draft-filter tester, no write; §6.2a) |
| `GET  admin/sales-import/:id/combos` | targets:read | → `{dimensionValues, dimensionCombos}` (the multi-combo picker source; latest READY import when `:id` = `latest`) |
| `POST admin/sales-import/uploads` | targets:upload | `{filename, sizeBytes}` (≤ 600 MB; ext .xlsx/.csv) → `{importId, partSize: 4194304, partCount}` |
| `POST admin/sales-import/:id/parts/:n` | targets:upload | multipart `file` (≤ 4 MiB + slack) → `{partsReceived}` (idempotent per n; 409 unless UPLOADING) |
| `POST admin/sales-import/:id/complete` | targets:upload | → `SalesImportSummary` (QUEUED). 400 if parts missing / Σsize ≠ sizeBytes |
| `POST admin/sales-import/:id/reprocess` | targets:upload | → QUEUED (from READY/NEEDS_MAPPING/FAILED; aggregates deleted first) |
| `DELETE admin/sales-import/:id` | targets:upload | cancel/delete: only if never applied. Deletes GCS prefix + aggregates. 409 otherwise |
| `GET  admin/sales-import` | targets:read | `?cursor&limit≤50` → `{items: SalesImportSummary[], nextCursor}` |
| `GET  admin/sales-import/:id` | targets:read | → `SalesImportSummary & {monthSummaries, errorSamples}` (poll every 2 s while QUEUED/PROCESSING) |
| `GET  admin/sales-import/:id/preview` | targets:read | → `SalesImportPreview` (READY only) |
| `POST admin/sales-import/:id/apply` | targets:upload | `ApplyRequest` → **202 `ApplyEnqueued`** since 2026-11-18 (a background job — §18 item 5; was `ApplyResult`; per month; one month failing does not roll back others) |
| `GET  admin/sales-import/:id/unmatched.csv` | targets:read | streams `sales-imports/<c>/<id>/unmatched.csv` (customer code, name, month, lines, ₹, qty) |
| `GET  admin/sales-import/:id/errors.xlsx` | targets:read | errorSamples as xlsx (`buildXlsx`, `common/xlsx.ts:132`) |
| `GET  admin/sales-months` | targets:read | `?from=YYYY-MM&to=YYYY-MM` (default last 6) → `SalesMonthRow[]` |
| `POST admin/sales-months/:month/close` | targets:upload | → `SalesMonthRow`. 409 if current month or already closed. Audit UPDATE `{action:'close'}` |
| `POST admin/sales-months/:month/reopen` | **@Roles('GIFSY_ADMIN')**, assumed | → `SalesMonthRow`. 409 if current/open. Audit UPDATE `{action:'reopen'}` |
| `POST sales-import/drain` (`@Public`) | header `x-drain-secret` = `SALES_IMPORT_DRAIN_SECRET`, fail-closed | → `{kicked:boolean}`. Kicks the job if QUEUED or stale PROCESSING exist (Cloud Scheduler fallback; mirrors `whatsapp-ops.controller.ts:56-67`) |

Changed existing responses (additive, only non-empty when owned KPIs exist):
- `POST /v1/admin/achievements/upload` → adds `skippedImporterOwnedKpis: string[]` (absent for tenants with none).
- `DELETE /v1/admin/achievements/batches/:id` → 409 `"This batch was written by Sales Import; manage it there."` for `status==='SALES_IMPORT'`.

---

## 6. Parsing rules (generic; Lane I owns, pure functions, 100% unit-tested)

### 6.1 Normalization
- `normalizeHeader(s)`: trim, collapse whitespace, uppercase, strip a leading BOM. A mapped header must match **exactly
  one** normalized header cell. Zero matches → NEEDS_MAPPING. Duplicates → NEEDS_MAPPING listing them. "CODE" never
  matches "CUSTOMER CODE" (exact, not contains).
- `normalizeDim(v)`: number → canonical decimal string (`500`, `500.0` → `"500"`); string → trim, collapse spaces, uppercase. Empty → `""`.
  Filters are normalized the same way at save time.
- `normalizeOutletCode(v)`: number → integer string without `.0`; string → trim. (Leading zeros are preserved. Risk R-6.)
- Amount: number cell → `Math.round(v*100)` paise. Text → strip `,`, `₹`, spaces → decimal → paise (BigInt). Negative is allowed.
  Invalid → row skipped with reason.
- Quantity: decimal → micro units: `round(v × 1e6)` BigInt (raw fractional cases kept; 0.04 → 40000).
- Date: an exceljs `Date` cell is a calendar date, so use its UTC Y-M-D. A numeric serial is the Excel 1900 epoch (handle the
  1900-leap bug). Text uses `dateOrder` with separators `-` `/` `.` and month names (`05-Oct-2026`). Text with a time part
  → `istMonthKey` (`ist-date.ts:123`). Month = `YYYY-MM` of the calendar date (invoice dates are IST calendar dates; no TZ shift).
  Invalid or before 2000 or after today+1 → row skipped.
- Blank outlet code → skipped (`reason: 'blank outlet code'`). Unmatched code → counted into the unmatched summary and the CSV,
  **not** an error.

### 6.2 KPI evaluation (pure, `sales-kpi.helper.ts`)
`lineMatches(dims, filter)` = (`anyOf` empty OR ∃ clause where every key equals) AND (no `noneOf` clause matches).
`kpiValue(aggs, def)` = Σ over matching aggregates of `amountPaise` (AMOUNT → `Number(sum)/100`, 2 dp) or `qtyMicro`
(QUANTITY → `Number(sum)/1e6`, raw fractional, up to 6 dp). BigInt sums prevent float drift.
Outlet scope: if `outletTypes`/`programs` are non-empty and the outlet is not in them → **key omitted** (blank ≠ 0,
consistent with the engine's null policy, `points-engine.types.ts:15-19`).
In-scope programme outlet with no matching lines → **0** (full rewrite, owner rule).

Generic examples (fixtures use `dimA`/`dimB`):

| KPI | measure | filter |
|---|---|---|
| all ₹ | AMOUNT | `{}` |
| dimA = X ₹ | AMOUNT | `{"anyOf":[{"dimA":"X"}]}` |
| dimA ≠ X ₹ | AMOUNT | `{"noneOf":[{"dimA":"X"}]}` |
| dimA=Y & dimB=500 ₹ / cases | AMOUNT / QUANTITY | `{"anyOf":[{"dimA":"Y","dimB":"500"}]}` |
| all cases | QUANTITY | `{}` |

`definitionsHash` = sha256 of the stable JSON of enabled definitions sorted by kpiCode (id-free).

### 6.2b Third measure: PRODUCT_COUNT ("LINES" — owner-approved 2026-11-13, net basis)
A definition with `measure: 'PRODUCT_COUNT'` (editor label **"Number of products bought (lines)"**) writes, for ONE outlet × ONE
month, the number of **distinct products** the outlet bought, where a product = one distinct combination of the profile's
dimension columns (the aggregate `dimKey`; for Bajaj: Brand = file `CODE` + SKU group = `CLUB SKU`).
- **Net basis:** a product counts only when Σ `amountPaise` over every MATCHING aggregate of that outlet × product in the month is
  **> 0**. Returns net off purchases: bought and fully returned → not counted; only zero-value (free) lines → not counted;
  negative-only → not counted. The value is never negative (`outletsNegative` stays 0).
- The normal filter (anyOf / noneOf) and outlet scope apply exactly as for ₹ / cases: only matching aggregates are considered;
  out-of-scope outlets are omitted; an in-scope outlet with no qualifying product → 0.
- **Implementation:** `OutletKpiAccumulator` keeps, only when a PRODUCT_COUNT definition exists, one per-outlet
  `Map<dimKey, net paise>` of products matching ≥ 1 PRODUCT_COUNT definition; `rawSum` counts the entries with net > 0 that match
  THAT definition (so the same product arriving in several aggregates / pages / history rows is netted, then counted once).
  AMOUNT / QUANTITY keep their BigInt fast path unchanged. Stored units = the count itself (integer; no ÷100 / ÷1000); the month
  total = Σ per-outlet counts. Every measure switch is exhaustive (`assertNeverMeasure`), so a future measure cannot silently fall
  into the cases branch.
- **Save rules:** needs the amount column (net amount) and ≥ 1 dimension column. The profile H2 guard also protects the amount
  column while an enabled PRODUCT_COUNT KPI exists. No migration (`SalesKpiDefinition.measure` is a plain String).
- Tester: for a PRODUCT_COUNT draft `POST kpis/test` also returns `months[].totalProducts` (Σ per-outlet counts) and judges
  "outlets > 0" on the count. FE shows PRODUCT_COUNT values as plain integers (no ₹, no "cases", no decimals).

### 6.2a Multi-combination (focus SKU set) KPIs (owner addition)
A focus KPI can be **any SET of attribute combinations summed together**, e.g. "ADHO 500 + ADHO 200 + ADHO 150", optionally mixed
with whole-brand entries and exclusions. The §6.2 model expresses this directly; no extra node type is needed:
```json
{ "anyOf": [ {"brand":"ADHO","skuGroup":"500"}, {"brand":"ADHO","skuGroup":"200"}, {"brand":"ADHO","skuGroup":"150"},
             {"brand":"CNO"} ],                     // whole-brand entry: only brand listed ⇒ every SKU group of CNO
  "noneOf": [ {"brand":"CNO","skuGroup":"50"} ] }   // optional exclusion (e.g. "all CNO except 50")
```
- **Semantics (set, not list):** a line is IN the KPI iff it matches **at least one** `anyOf` entry AND **no** `noneOf` entry.
  A line that matches two entries (e.g. `{brand:ADHO,skuGroup:500}` and `{brand:ADHO}`) is **counted once**. Evaluation is a boolean
  per aggregate row, never a per-entry sum, so overlap can't double count.
- **Summing:** ₹ = Σ `amountPaise` of the matching aggregates; cases = Σ `qtyMicro`. These are the same aggregates, so a "₹" KPI and a
  "cases" KPI built on the same set always describe the same lines (author two definitions, one per measure, with an identical filter;
  the editor offers "Duplicate as cases KPI"). Returns (negative lines) net off inside the set.
- `CODE ≠ ADHO` = `{"noneOf":[{"brand":"ADHO"}]}` with `anyOf` empty (= all lines except ADHO).
- **Limits (validated on save):** ≤ 200 `anyOf` + ≤ 200 `noneOf` entries; each entry has 1..N keys, all ⊆ profile dimension keys; no
  empty entry `{}` inside `anyOf` (use `filter: {}` for "all"); exact duplicate entries are de-duplicated with a note. Values are
  normalized (`normalizeDim`), so `ADHO`/`adho `/`Adho` are the same.
- **Entry UX (Lane F, F-6):** a "Product set" builder with three ways to add entries: (1) **pick combos** from a searchable,
  sortable table of the distinct combinations seen in the latest READY import (`dimensionCombos`: brand · SKU group · lines · ₹ ·
  cases; multi-select checkboxes; "select all ADHO" quick filter); (2) **whole-brand** chips (from `dimensionValues.brand`) that add
  `{brand:X}`; (3) **free entry** (type brand and optional SKU group) for products not yet in any file. Exclusions use the same picker
  in an "Exclude" tab. The set shows as chips ("ADHO 500", "ADHO 200", "CNO (all sizes)", "except CNO 50") with a live running total
  per month from `POST kpis/test`.
- **Validation warnings (non-blocking):** entries that match **no line** in the latest import ("ADHO 150 never appears in the latest
  file. Check spelling or size.") are returned by `POST kpis/test` as `unmatchedEntries: number[]` (indexes into anyOf/noneOf).
  Entries **fully covered by another entry** ("ADHO 500 is already included by ADHO (all sizes)") come back as `redundantEntries`.
  Blocking errors: an unknown dimension key, an empty entry, > 200 entries.
- The contract change: `POST admin/sales-import/kpis/test` → `{months:[{month,totalAmountRupees,totalQuantity,totalProducts?,outletsNonZero}],
  unmatchedEntries:{anyOf:number[],noneOf:number[]}, redundantEntries:{anyOf:number[]}, matchedLines:number}`.

### 6.3 Month summary warnings
- `STARTS_AFTER_FIRST`: `firstDate` day ≠ 01. `ENDS_BEFORE_MONTH_END`: `lastDate` < the month's last day AND month ≠ current month.
  Applying a month with either needs it listed in `acknowledgePartialMonths`, because the whole month is replaced by a partial file.
- `OLDER_THAN_LAST_APPLIED`: this import's `createdAt` < the month's `lastAppliedImportId` import `createdAt`.
- `REPLACES_MANUAL_VALUES`: some existing row for the month has an owned key whose value was written by a non-`SALES_IMPORT` batch
  (first apply after a KPI moved from manual to importer).
- ~~`ROSTER_CHANGED`~~ — REMOVED in the audit fix round (§10a.8 M6): the worker aggregates every customer code and
  preview/apply map them onto the roster current at that moment, so a roster change never blocks apply.
- `OLDER_THAN_LAST_APPLIED` (superseded by §10a.8 UX-1): compares DATA recency — this file's latest invoice date in the
  month vs the last-applied import's latest invoice date in that month — not upload time.

---

## 7. Behaviour specs

### 7.1 Worker (Lane I)
1. Claim: `UPDATE sales_imports SET status='PROCESSING', "startedAt"=now(), attempts=attempts+1, "heartbeatAt"=now()
   WHERE id = (SELECT id FROM sales_imports WHERE status='QUEUED' OR (status='PROCESSING' AND "heartbeatAt" < now()-interval '10 minutes')
   ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. attempts > 3 → FAILED. Loop until nothing is claimable, then exit 0.
2. Re-check `features.salesImport` (uncached). If OFF → FAILED "feature disabled".
3. Load the profile. If missing → NEEDS_MAPPING with `detectedHeaders` (first 10 rows).
4. Load the roster `Outlet{clientId, deletedAt:null}` → `Map(outletCode → {name, type, program})`, plus `rosterHash`.
5. Build one Readable from parts `0..n-1` in order (`storage.bucket.file(key).createReadStream()` chained), tee into
   sha256 + a byte counter.
6. XLSX: `new ExcelJS.stream.xlsx.WorkbookReader(stream, {sharedStrings:'cache', hyperlinks:'ignore', styles:'cache', worksheets:'emit'})`.
   Iterate the selected sheet's rows. CSV: `parseCsvStream` (RFC-4180: quotes, `""`, CRLF/LF, BOM, configurable delimiter auto-detected from the header line `,`/`;`/`\t`).
7. Rows before the header row are ignored (this is how the DMS "X" marker row is skipped; it is just a row above the header).
8. Per row: parse → skip with reason, or accumulate `agg[month|outlet|dimKey] += {paise, micro, lines}` for matched outlets,
   or `unmatched[month|code] += …`. Month summary counters too. `dimensionValues` keeps per-dim value counts (top 200);
   `dimensionCombos` keeps every distinct full combo (lines, ₹, qty; capped at 2,000 by |₹|) for the §6.2a picker.
9. Every 5 s or 20k rows: `UPDATE … SET "rowsRead", "bytesRead", "heartbeatAt"` (a single statement).
10. End: `createMany` aggregates in chunks of 5,000 (delete existing aggregates for the import first, so a reprocess is idempotent).
    Upload `unmatched.csv`. Set `contentSha256`, `duplicateOfId` (earlier READY import, same tenant and sha), `monthSummaries`,
    `rosterHash`, `mappingSnapshot`, READY. On any throw → FAILED with a message (no stack).
11. Memory budget (REVISED in the re-audit: since M6 the worker aggregates EVERY customer, not only the ~6.5k roster
    outlets). Heap is capped at 1.7 GB (`NODE_OPTIONS=--max-old-space-size=1700`, §14; was 1536, see the revision below). Measured in spike (a) ≈ 0.4 KB of
    heap per tracked entry (Map entry + BigInts + key strings). Budget:
    - exceljs shared-strings cache ≤ ~350 MB (sharedStrings.xml itself capped at 512 MB unpacked; the cache is smaller);
    - tracked entries (aggregates + unmatched rows) ≤ **1.8 M combined** (aggregates ≤ 1.5 M, unmatched ≤ 0.9 M) ≈ 720 MB;
    - distinct customer codes ≤ **600 k** (`SALES_IMPORT_MAX_DISTINCT_CODES`) ≈ 50 MB; unmatched names ≤ 80 chars;
    - ⇒ ≈ 1.1 GB worst case < 1.5 GB. The real 205 MB file needs ≈ 0.6 M aggregates + 0.4 M unmatched rows and ≈ 0.2 M
      codes (≈ 55 % of the entry budget); a 300 MB file of the same shape ≈ 80 %.
    - Backstop: every 10k rows the worker compares `heapUsed` with 85 % of V8's heap limit and fails the import with
      "too large to process in one go — split it by month" before an OOM kill, whatever the file's shape.
    Exceeding any cap → FAILED with a readable message (never an OOM).
    **Revised after the real-DB / real-file run (2026-11-10):** the real 205 MB file peaked at heap ≈ 1.06 GB / RSS ≈ 1.32 GB;
    a leaky build died in GC at ≈ 1.30 GB of a ≈ 1.58 GB limit (≈ 82 %) without the old 85 % / 10k-row guard firing. Now:
    job heap `--max-old-space-size=1700` on the 2 GiB job. NOTE (audit of fe04e04, M-1): that flag sizes the OLD space
    only — on node:24-alpine V8's heap_size_limit becomes ≈ 1,892 MB, so a fraction of heap_size_limit trips far too late
    in a 2 GiB container. The budget is therefore FIXED bytes derived from the old-space size (`ingest/heap-budget.ts`):
    the guard trips at **75 % of the old-space size = 1,275 MiB of USED heap** (the real file peaks at ≈ 1.06 GB ≈ 83 % of
    that, > 15 % margin) after two consecutive over-threshold checks, checked every **2,000 rows (since the last check)
    and at least every 2 s**. The old-space size is read from the process flags (execArgv over NODE_OPTIONS), else
    estimated as 90 % of heap_size_limit.
    **Enforced, not just documented (audit M1/M2):** the job args carry `--max-old-space-size=1700` (§14), and
    `worker.main.ts` checks V8's heap limit at startup — below 1,600 MB it re-executes itself once with the flag, and fails
    fast with a clear log if the heap is still too small. The guard runs from every row AND from an unref'd 2 s timer, so
    phases without rows (exceljs building shared strings, the aggregate write loop, the unmatched.csv build) are covered;
    a trip destroys the current input stream and ends the import FAILED with the readable message. Only USED heap counts.
    The xlsx shared-strings cap is min(400 MiB, 25 % of the old-space size) — **400 MiB** for the job. The worker's startup
    heap check imports only Node built-ins; Nest / Prisma / ExcelJS load after it, so a re-executing parent stays tiny.
    A heap abort is always reported as "too large" (never as a "corrupt" xlsx: the re-sequencer does not report errors
    after its output was destroyed, and the parse checks the abort flag first). The import detail page's month summary
    rounds quantities per outlet / per customer exactly like the preview (audit L-4).
    Displayed quantities follow the stored values too: preview matched quantity = Σ per-outlet 3-dp values, unmatched =
    Σ per-customer 3-dp values; the KPI tester sums per-outlet stored values (audit L2/L3).

### 7.2 Apply (Lane K), per month, ONE interactive transaction (`timeout: 120_000`)
```ts
await this.prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sales-month:${clientId}:${month}`}, 0))`;
  // 1. re-check month OPEN (resolveMonthState inside tx), import READY, roster hash, definitionsHash
  // 2. batch = tx.salesUploadBatch.create({ data:{ clientId, uploadedById:user.sub, month, status:'SALES_IMPORT',
  //      totalRows: outlets, acceptedCount: outlets, rejectedCount: 0 } })
  // 3. rows = computeMonthKpis(...)  → [{outletCode, outletName, values:{[kpiCode]: number}}] for every roster outlet
  //    in ANY owned KPI's scope (values omit out-of-scope KPIs; zero-filled when no lines)
  // 4. bulk merge, chunks of 3,250:
  await tx.$executeRaw`
    INSERT INTO "outlet_sales_records" ("id","clientId","outletCode","outletName","month","kpiValues","batchId","createdAt","updatedAt")
    SELECT u.id, ${clientId}, u.code, u.name, ${month}, u.vals::jsonb, ${batch.id}, now(), now()
    FROM unnest(${ids}::text[], ${codes}::text[], ${names}::text[], ${valsJson}::text[]) AS u(id, code, name, vals)
    ON CONFLICT ("clientId","outletCode","month") DO UPDATE
      SET "kpiValues" = (outlet_sales_records."kpiValues" - ${owned}::text[]) || EXCLUDED."kpiValues",
          "updatedAt" = now()`;          // NOTE: batchId and outletName of EXISTING rows are NOT changed (§7.4)
  // 5. strip owned keys from rows of this month whose outlet is no longer on the roster:
  await tx.$executeRaw`UPDATE "outlet_sales_records" SET "kpiValues" = "kpiValues" - ${owned}::text[], "updatedAt"=now()
    WHERE "clientId"=${clientId} AND "month"=${month} AND NOT ("outletCode" = ANY(${rosterCodes}::text[]))
      AND "kpiValues" ?| ${owned}::text[]`;
  // 6. tx.salesImportApply.create({...snapshot, totals:{before (read at step 1), after}})
  // 7. tx.salesMonthStatus.upsert({ lastAppliedImportId, lastAppliedAt })  (state untouched)
  // 8. tx.auditLog.create({ data:{ action:'IMPORT', entityType:'SALES_MONTH', entityId:`${clientId}:${month}`,
  //      actorId:user.sub, newValues:{importId, definitionsHash, outletsWritten, totals}, metadata:{clientId, applyId} } })
}, { timeout: 120_000, maxWait: 10_000 });
```
`ids` come from `randomUUID()` (`node:crypto`, the same safe import the delivery-status memory recommends). Only rows that are
INSERTED use them. A month failure is returned in `ApplyResult` and never affects other months.

### 7.3 Month state (Lane K, pure `resolveMonthState(month, nowMonthIST, overrideRow?)`)
- `month > current` → not appliable ("future"). Files containing future-dated lines show the month as blocked.
- `month == current` → OPEN, always. Close is not allowed.
- `month == previous` → `override?.state ?? 'OPEN'`.
- `month < previous` → `override?.state ?? 'CLOSED'`.
- Close: allowed when not current and resolved OPEN → upsert `{state:'CLOSED', closedAt, closedById}`. Same advisory lock as apply.
  The UI warns if `lastAppliedAt` is null ("closing a month that was never imported").
- Reopen (GIFSY_ADMIN, assumed): allowed when resolved CLOSED and not current → `{state:'OPEN', reopenedAt, reopenedById}`. Audit.
  A reopened older month stays OPEN until closed again.
- Current month uses `currentMonthKey()` (`targets.helpers.ts:134`, IST).

### 7.4 Source ownership in the manual achievement upload (Lane K; the ONLY edit to shared targets code)
New pure helper `api/src/common/sales-kpi-ownership.ts`:
```ts
export async function importerOwnedKpiCodes(prisma: PrismaService | Prisma.TransactionClient, clientId: string): Promise<string[]> {
  const rows = await prisma.salesKpiDefinition.findMany({ where: { clientId, enabled: true }, select: { kpiCode: true } });
  return rows.map((r) => r.kpiCode).sort();
}
```
Edits in `targets.service.ts`, each wrapped in `if (owned.length > 0) { … }` so the existing path is untouched when it is empty:
1. `buildAchievementTemplate` (`:648-694`): filter `kpiRows` to exclude owned codes (the template has no owned columns).
2. `uploadAchievements` (`:714-841`): `owned = await importerOwnedKpiCodes(...)` right after `kpiRows` (`:718-721`).
   If non-empty: pass `kpis.filter(k => !owned.includes(k.code))` to `parseTargetUploadBuffer` (unknown labels are already
   skipped, `targets.helpers.ts:486-488`). Detect owned labels present in header row 2 → `skippedImporterOwnedKpis`.
   For the upsert, pre-load existing rows for the months (`findMany({where:{clientId, month:{in}}, select:{outletCode,month,kpiValues}})`)
   and set `update.kpiValues = { ...pick(existing, owned), ...kpiMap }` and `create.kpiValues = kpiMap`. Owned keys survive.
   Return `skippedImporterOwnedKpis`.
3. `deleteAchievementBatch` (`:862-870`): `batch.status === 'SALES_IMPORT'` → 409 (always; Deoleo never has such a batch).
   If `owned.length > 0` and it is a manual batch: in one tx, for rows `batchId = id` that contain any owned key, strip the
   NON-owned keys and repoint `batchId` to the latest `SALES_IMPORT` batch of that month (it must exist, since owned keys come
   only from an apply). Then delete the batch (the cascade removes the remaining rows that hold only manual data). Manual
   data is removed; importer data stays.

The importer never touches non-owned keys (step 4 `||` only adds owned keys; `-` only removes owned keys). Ownership is
symmetric.

---

## 8. Lanes, phases, time

| Phase | What | Who | Wall-clock (agent) |
|---|---|---|---|
| **P0 Contract and schema (serial)** | Lane-0: migration + models + `prisma generate`; `sales-import.contract.ts` + FE `types.ts`; module skeleton registered in `app.module.ts` (after `OffersModule`, `app.module.ts:53`) with empty controllers; `features.salesImport` flag plumbing (BE projections + FE flag + console label). Phase-0 **spikes**: (a) exceljs streaming 650k-row synthetic xlsx in a 2Gi container: time + peak RSS; (b) Cloud Run job trigger from the API SA on staging (needs owner OK for the IAM binding, D-4). | orchestrator | **1.5–2 h** |
| **P1 Lanes in parallel** | Lane I (ingest) · Lane K (KPI/month/apply/ownership/guard) · Lane F (frontend) | 3 agents | **I: 6–8 h · K: 6–8 h · F: 7–9 h** → **~8–9 h wall** |
| **P2 Integrate and gate** | wire runner ↔ worker ↔ preview; FULL `bash scripts/gates.sh`; docker build asserts | orchestrator | **1.5–2 h** |
| **P3 Audits** | independent adversarial: **correctness/data** (zero-fill, ownership, month math, BigInt) + **identity/tenancy** (cross-tenant import ids, flag bypass, reopen role) + **UI/UX** lane | 3 fresh agents | **2–3 h** |
| **P4 Runtime and staging** | local real-login role matrix; then staging (owner approves push + infra) with synthetic and the real file (§13) | orchestrator + owner | **3–4 h + owner UAT** |

**Total ≈ 16–20 agent-hours, ~2 working days elapsed** plus owner gates (D-1..D-5 answers, the infra/IAM change, push, UAT).

---

## 9. The Bajaj BSC rule the admin authors (data, not code; confirms the engine needs no change)

Verified against code: the compute service hands the evaluator the whole `achievements` and `targets` maps
(`points-compute.service.ts:193-194,247-253`). Inputs can reference any KPI via `kpiCode` or `source: 'pct:<KPI>'`
(`points-engine.helper.ts:124-145`). Publish reconciles every referenced code incl. `pct:` keys against enabled KpiDefs
(`points-engine.service.ts:375-390, 485-501`). **So one rule CAN use a ₹ %-of-target gate plus a cases measure.** Both
KPIs need KpiDef rows (`BSC CASES` must exist as a KpiDef, unit "cases"). The ₹ KPI needs a target in `OutletTarget`
(manual target upload, unchanged). A space in a KPI code is fine (`source.indexOf(':')` slicing).

```json
{
  "effectiveFrom": "2026-11-01",
  "effectiveTo": null,
  "attachsTo": { "scope": "program_kpi", "program": null, "programCategory": null, "kpiCode": "BSC CASES" },
  "evaluationBasis": "PERIOD_AGGREGATE",
  "output": { "awardType": "POINTS", "fieldId": "<id of the BSC points CreditField>" },
  "rounding": { "mode": "floor", "scale": 0 },
  "inputs": [
    { "ref": "cases",    "kpiCode": "BSC CASES",            "type": "number", "nullAs": "zero" },
    { "ref": "salesPct", "source":  "pct:MONTH TARGET",     "type": "number", "nullAs": "skipRule" }
  ],
  "pipeline": [
    { "type": "segmentFilter", "id": "onlyWholesalers", "field": "outletType", "allow": ["WHOLESALER"], "onFail": "zero" },
    { "type": "gate", "id": "salesTargetMet", "when": { "op": "gte", "left": { "var": "salesPct" }, "right": { "lit": 100 } }, "onFail": "zero" },
    { "type": "formula", "id": "perWholeCase", "expr": "floor(cases) * 10", "output": "add" },
    { "type": "cap", "id": "monthlyCap", "max": 50000 }
  ]
}
```
Semantics: no `MONTH TARGET` target → `skipRule` → 0. pct < 100 → 0. Else `floor(cases) × 10`, capped. Rate and cap are
placeholders (D-8). "BSC" = outlet type `WHOLESALER` (BAJAJ-DATA-MIGRATION.md:74). Lane K Task K-9 proves this exact JSON
through the real `/v1/admin/points-compute/simulate` and `previewCompute` against importer-written rows (no engine edits).

---

## 10. Lane-0 tasks (orchestrator, serial; must land before lanes start)

**0-1 Migration and models.** Add §4 models to `api/prisma/schema.prisma` after line 3025. `npx prisma migrate dev --create-only
--name add_sales_import`, then rename the folder to `20261110120000_add_sales_import`. Review that the SQL is additive only.
`npx prisma generate`. Verify: `cd api && npx nest build` exits 0.

**0-2 Contract files.** `api/src/sales-import/sales-import.contract.ts` (§5.1 verbatim) and `platform/src/lib/sales-import/types.ts`
(same types). Verify: `cd platform && npx tsc --noEmit`.

**0-3 Flag plumbing (copy `offerTiles` exactly).**
- BE: add `salesImport: !!features.salesImport,` beside `offerTiles` at `gifsy.service.ts:619,765,1018`.
- FE: `client-config.ts:79` add `salesImport: boolean;`, `default-client-config.ts:55` `salesImport: false,`, `tenant-features.ts:67`
  `salesImport: bool(f.salesImport, d.salesImport),`. Console label in `app/gifsy/clients/[slug]/page.tsx` (near `:36`) and
  `clients/new/page.tsx` (`:47` default false, `:66` label): *"Sales Import (DMS file): upload the distributor invoice-line file to
  compute importer-owned KPI achievements per month. Leave OFF unless the tenant's column mapping and KPIs are configured."*
- Test (vitest, copy `lib/__tests__/tenant-features.test.ts:52-56`):
```ts
it('carries the salesImport flag, defaulting OFF', () => {
  expect(DEFAULT_FEATURES.salesImport).toBe(false);
  expect(normalizeFeatures({}).salesImport).toBe(false);
  expect(normalizeFeatures({ salesImport: true }).salesImport).toBe(true);
  expect(normalizeFeatures({ salesImport: 'yes' }).salesImport).toBe(false);
});
```

**0-4 Module skeleton.** `api/src/sales-import/{sales-import.module.ts, sales-import.controller.ts, sales-months.controller.ts,
sales-import-access.ts}`, registered in `app.module.ts`. `sales-import-access.ts`:
```ts
export async function assertSalesImportAccess(user: JwtPayload, tenant: TenantService, tenantSettings: TenantSettingsService,
  opts: { write: boolean }): Promise<void> {
  const unassumedOperator = platformWide(user) || (user.role === 'GIFSY_STAFF' && !user.assumed);
  if (unassumedOperator) throw new BadRequestException('Assume a tenant to use Sales Import.');
  const features = opts.write
    ? await tenantSettings.getFeaturesUncached(user.clientId)   // add if absent: thin uncached read of clients.features
    : await resolveTenantFeatures(tenant, user.clientId);       // common/tenant-features.helper.ts:15
  if (features.salesImport !== true) throw new ForbiddenException('Sales Import is not enabled for this tenant.');
}
```
(Lane K checks whether `TenantSettingsService` already has an uncached features read. `getEffectiveSettings` is used uncached
for the engine money gate. Reuse it, don't fork.)
Test: `sales-import-access.spec.ts`: un-assumed GIFSY_ADMIN → 400; flag off → 403; CLIENT_ADMIN + flag on → ok.

**0-5 Spikes (findings recorded in this doc §15 before P1 ends).**
(a) `api/scripts/spike-exceljs.ts`: generate a 650k × 76 xlsx with the exceljs streaming *writer*, read it with
`WorkbookReader`, print rows/s + `process.memoryUsage().rss` max. Pass = < 10 min and < 1.5 GB. (b) Staging job trigger:
deploy a no-op job, call `jobs/:run` from a one-off Cloud Run job running as `gifsy-api-sa`. Pass = HTTP 200 + execution
created. ⚠️ Infra and IAM need the owner's go (D-4).

---

## 10a. Phase-0 outcome (Lane-0 landed, 2026-11-09). READ BEFORE STARTING A LANE

Branch `feat/sales-import` (worktree `.claude/worktrees/sales-import`). Gates at that commit: api tsc (only the known TS6059
noise), FULL api jest, `nest build`, platform tsc, FULL platform vitest. Real exit codes are in the commit message.

### 10a.1 What landed
| Item | Where |
|---|---|
| Migration `20261110120000_add_sales_import`: 6 `CREATE TABLE`, 9 indexes, 2 FKs (both to `sales_imports`). **No existing table altered.** Generated with `prisma migrate diff --from-schema <before> --to-schema prisma/schema.prisma --script`; no dev DB touched. | `api/prisma/migrations/20261110120000_add_sales_import/migration.sql`; models after `OutletTarget` in `schema.prisma` |
| `exceljs@4.4.0` (exact pin, published 2023-10-19, in `dependencies`) | `api/package.json` + lockfile. The dependency half of task I-0 is DONE |
| Docker guards: `RUN ls dist/sales-import/worker.main.js` (builder) and `RUN node -e "require('exceljs')"` after `npm ci --omit=dev` (runner) | `api/Dockerfile` |
| Jest guard: every bare import under `src/sales-import/**` (non-spec) must be a node builtin or a package.json **`dependencies`** entry; exceljs must be exact-pinned | `api/src/sales-import/sales-import.contract.spec.ts` |
| Contract + FE mirror, with a jest PARITY test (bodies identical below the header comment) | `api/src/sales-import/sales-import.contract.ts`, `platform/src/lib/sales-import/types.ts` |
| Flag `features.salesImport` (default OFF): BE console projections (3 sites) + spec; FE `FeatureFlags`, default, `normalizeFeatures`, console labels (edit + new client) + vitest | `gifsy.service.ts`, `client-config.ts`, `default-client-config.ts`, `tenant-features.ts`, `app/gifsy/clients/[slug]/page.tsx`, `clients/new/page.tsx` |
| Access gate + spec | `api/src/sales-import/sales-import-access.ts` |
| Module skeleton registered in `app.module.ts` after `OffersModule`; worker entry + worker module | see 10a.3 |

**No routes exist yet.** The controllers are empty classes, so the API surface is unchanged until the lanes add handlers.

### 10a.2 Deviations from §5 / §10 (binding for the lanes)
1. **Access helper signature.** `assertSalesImportAccess(user, { tenant, prisma }, { write })`, not `tenantSettings`. The uncached
   write-path read is `isSalesImportEnabledUncached(prisma, clientId)` in the same file: a direct `clients.features` read, fail-closed,
   INACTIVE → false. Reason: no uncached `clients.features` read existed, and adding one to the shared `TenantSettingsService` would be
   a platform-wide edit for no gain. The worker (§7.1 step 2) and the D-1 guard (K-8) MUST use `isSalesImportEnabledUncached`.
2. **Wire numbers are rupees/cases, never BigInt.** `dimensionValues` = `{dimKey: [{value, lines, amountRupees}]}` and
   `dimensionCombos` = `[{dims, lines, amountRupees, quantity}]` (the plan text said `amountPaise`/`qtyMicro`). The worker stores these
   JSON columns in exactly the contract shape (`SalesDimensionValues`, `SalesDimensionCombo[]`), so the read endpoint is a pass-through.
3. **Types the plan used but did not name** were added: `SalesKpiDefinitionList` (GET kpis = `{definitions, definitionsHash}`),
   `SalesKpiDefinitionPatch`, `SalesKpiTestRequest`/`SalesKpiTestResult` (§6.2a shape; `importId` may be `'latest'`),
   `CreateSalesImportUploadRequest/Result`, `SalesImportPartResult`, `SalesImportList`, `SalesImportDetail`, `SalesImportErrorSample`,
   `SalesImportCombos` (includes the resolved `importId`), `SalesMonthWarning`, `MonthPreviewKpi`, `ApplyMonthResult`,
   `SalesImportDrainResult`, `AchievementUploadOwnershipExtension`, `SalesDimensionMapping`, `SalesImportFileKind`, `SalesMonthState`.
4. **Shared constants** live in the contract (both sides): part size 4 MiB, max file 600 MB, part limit (+64 KiB), allowed extensions,
   `SALES_IMPORT_BATCH_STATUS='SALES_IMPORT'`, max dims 6, dim-key regex, 200-entry filter cap, error/value/combo caps, stale heartbeat
   10 min, max attempts 3. Use them; do not re-declare the literals.
5. **Schema = §4 verbatim** (formatting only).
6. Task 0-5 spike (a) ran on the REAL 205 MB file instead of a synthetic one (owner request). Spike (b) was a documentation check, not a
   staging deploy: no GCP resource was created and no IAM was changed (owner instruction).

### 10a.3 File ownership (no two lanes edit the same file)
| File | Owner | Notes |
|---|---|---|
| `sales-import.module.ts` | Lane-0 (frozen) | Imports `SalesImportIngestModule` + `SalesImportKpiModule`. **Controller order is load-bearing** (static `profile`/`kpis` before `:id`), pinned by `sales-import.module.spec.ts` |
| `sales-import.contract.ts` + FE `types.ts` | Lane-0 | A change needs BOTH files in the same commit (parity test) plus a note here |
| `sales-import-access.ts` | Lane-0 | |
| `ingest/**` (`normalize.ts`, processor, runner, `sales-import-ingest.module.ts`, `sales-import-worker.module.ts`), `worker.main.ts`, `sales-import.controller.ts`, `sales-import-drain.controller.ts`, the `storage.service.ts` additions, `api/scripts/make-synthetic-sales.ts` | **Lane I** | Register new ingest injectables in `sales-import-ingest.module.ts`. In `normalize.ts`, `normalizeHeader/Dim/OutletCode` are implemented (Lane K imports `normalizeDim`); `toPaise/toMicro/parseInvoiceDate` are throwing stubs |
| `kpi/**`, `months/**`, `apply/**`, `sales-import-config.controller.ts`, `sales-import-apply.controller.ts`, `sales-months.controller.ts`, `common/sales-kpi-ownership.ts`, the `targets.service.ts` edits, the D-1 guard + `points-compute.controller.ts` decorators | **Lane K** | Register new K injectables in `kpi/sales-import-kpi.module.ts`. It has no controllers and no engine import, so `PointsEngineModule` may import it for the D-1 guard |
| `platform/src/app/admin/sales-import/**`, `platform/src/lib/sales-import/**` except `types.ts`, the nav entry in `app/admin/layout.tsx`, the `app/admin/sales/page.tsx` tweak | **Lane F** | |

Skeleton injections already in place: config controller ← `SalesProfileService`, `SalesKpiDefService`; apply controller ←
`SalesPreviewService`, `SalesApplyService`; months controller ← `SalesMonthsService`; import and drain controllers ←
`SalesImportRunnerService`. Every admin controller also gets `TenantService` + `PrismaService` for the access gate and already carries
`@Roles('CLIENT_ADMIN','GIFSY_ADMIN')`; handlers add `@RequirePermission('targets:…')`. Reopen uses a METHOD-level
`@Roles('GIFSY_ADMIN')` (RolesGuard uses `getAllAndOverride`, so it replaces the class roles) plus an `assumed` check.

### 10a.4 Spike (a): exceljs streaming read of the REAL DMS file (measured; Node 24.14.1, local Windows desktop)
File: 204.8 MB xlsx, 1 sheet, 635,430 rows (header at row 2; the marker row above it is skipped by auto-detect), 76 columns,
635,428 data rows, 2 rows with a blank customer code. **Every invoice date is a real date cell** (0 text dates) and every customer code
is a numeric cell. 2 months, 198,772 distinct customer codes. Shared strings come BEFORE the sheet in this file (first row after ~5 s).
The script read only the 7 Appendix-A columns by header and built a BigInt Map keyed `month|code|{brand,skuGroup}` for **every**
customer (586,120 keys). That is a deliberate upper bound: the real worker aggregates only roster-matched outlets (~6.5k) plus a small
unmatched map. No row values were printed or stored.

| Run | Wall | CPU (user+sys) | Peak RSS | Peak heap used |
|---|---|---|---|---|
| exceljs only, no aggregation, default heap (4.3 GB limit) | 71.6 s | 86.6 s | **505 MB** | 348 MB |
| full aggregation, `--max-old-space-size=1536`, all cores | 82.8 s | 106.6 s | **790 MB** | 619 MB |
| full aggregation, heap 1536, **pinned to ONE core**, uncontended | **86.9 s** | 80.1 s | **572 MB** | 439 MB |
| full aggregation, `--max-old-space-size=768` (machine busy) | 169.2 s | 182.5 s | 729 MB | 523 MB (still completes) |
| full aggregation, default heap (lazy GC; machine busy) | 136.2 s | 124.5 s | 1,034 MB | 1,012 MB |

**Extrapolation to a 300 MB file (×1.47, linear; conservative, because the shared-strings cache grows with DISTINCT strings, not rows):**
about 930k rows, ≈ 130 s on one local core. Budget **3–7 min on one Cloud Run vCPU** (assume it is 1.5–3× slower than this desktop
core). Peak RSS ≈ 0.85–1.2 GB in the all-customer worst case with the heap capped at 1.5 GB.

**Recommended job size: 2 GiB memory, 1 vCPU, `NODE_OPTIONS=--max-old-space-size=1536` (SUPERSEDED: 1700, §7.1 step 11 / §14), task-timeout 3600 s, max-retries 1.** That
leaves ≥ 0.8 GB headroom at 300 MB. 2 vCPU is not needed (≈ 1.2 cores of parallelism observed: zlib + GC threads); 4 GiB is not
needed. Task 0-5a's pass criterion (< 10 min, < 1.5 GB) is met. Without the heap cap V8 collects lazily (1,034 MB in the default-heap
run), so set the cap. ⚠️ Lane I: Cloud Run's filesystem is in-memory. If a file puts `sharedStrings.xml` AFTER the worksheet in the zip,
exceljs may buffer the sheet. Cover that order in the I-4 tests and fail with a readable message rather than an OOM.

### 10a.5 Spike (b): IAM to start a Cloud Run Job execution from the API (docs-checked 2026-11-09; VERIFIED on staging 2026-11-11)
From the Cloud Run IAM roles reference (docs.cloud.google.com/run/docs/reference/iam/roles) and the "Execute jobs" page:
- `run.jobs.run` (execute, NO overrides) is in `roles/run.invoker`, `roles/run.jobsExecutor`, `roles/run.jobsExecutorWithOverrides`,
  `roles/run.developer`, `roles/run.admin`.
- `run.jobs.runWithOverrides` (execute WITH overrides: args/env/task count/timeout) is in `roles/run.jobsExecutorWithOverrides`,
  `roles/run.developer`, `roles/run.admin`. It is **NOT** in `roles/run.invoker`.
- **Recommendation:** grant `gifsy-api-sa` **`roles/run.jobsExecutorWithOverrides` on the single job resource** if the runner passes
  overrides (it contains `run.jobs.run`, `run.jobs.runWithOverrides`, `run.executions.cancel`). If the runner keeps the plan's
  no-override design (the job claims QUEUED rows itself), `roles/run.jobsExecutor` is enough. Bind on the job, not the project, so the
  API SA cannot start the migrate/seed jobs.
- `iam.serviceAccounts.actAs` is not listed for executing a job (it applies to deploy/update). It is moot anyway: the job runs as the same
  `gifsy-api-sa`. **Verified on staging 2026-11-11** (binding owner-approved): with `roles/run.jobsExecutor` only, the API started the job
  execution <1 s after the real upload completed (no overrides needed).

### 10a.6 What the lanes must know before starting
- Run `npm ci` in `api/` and `platform/`, then `npx prisma generate` in `api/` (tsc needs the new models).
- The flag is read UNCACHED on writes; reads use the 5-min cached tenant config. Both fail closed.
- Deoleo is byte-identical so far. The only observable change: the Gifsy console's client GET/PATCH/list projections now include
  `salesImport: false` (the same as when `offerTiles` was added). No new routes are live.
- In the real file every date is a date cell and every code a number. Codes are integers (`normalizeOutletCode` strips `.0`); compare
  roster codes as strings after that normalization (risk R-6).
- Never print or commit real file values; the file stays outside the repo.

### 10a.7 Phase-2 integration (after lanes I, K, F merged)
- **Contract addition:** `SalesSegmentOptions { outletTypes: Array<{code,name}>; programs: string[] }` for
  `GET admin/sales-import/segment-options` (targets:read) — in both `sales-import.contract.ts` and FE `types.ts`; the
  temporary declaration in `kpi/sales-kpi-def.service.ts` is gone. The KPI editor's outlet-type / programme scope are
  checkbox multi-selects fed by it (free text only when a list is empty/unavailable).
- **One roster hash:** `rosterHashOf` + `rosterOutletWhere` in `ingest/roster.ts` are the single source; the worker
  (`loadRoster`) and preview/apply (`loadRosterMeta` → `rosterHashOfMap`) both use them. Pinned by
  `roster-hash.parity.spec.ts`. Lane K's copy in `sales-kpi.helper.ts` was removed.
- **Single-source helpers:** `paiseToRupees` / `microToCases` in `ingest/normalize.ts` (aggregator + KPI evaluator).
  FE `normalizeDim` (`lib/sales-import/product-set.ts`) now mirrors the backend exactly (it lacked the "500.0" → "500"
  decimal-zero trim), with the backend's vectors copied into its test.
- **FE ↔ BE route parity** is pinned by `api/src/sales-import/fe-route-parity.spec.ts` (every FE call in `api.ts`/
  `upload.ts` hits a real handler; every admin handler is used by the FE; only `POST sales-import/drain` is BE-only).

---

### 10a.8 Audit fix round (backend, 2026-11-10) — binding deviations
Three independent audits; every item fixed with tests. Contract commits `c5e7d42` + `c93f719` (both contract files).
Additive migration `20261111120000_sales_import_hardening` (touches only the two unreleased sales-import tables):
`claimToken`, `mappingFingerprint`, `processingVersion`, `purgedAt`, `queuedAt`, index `(status, finishedAt)`, and
`sales_import_aggregates.qtyMicro` → `qtyPico` (rescaled ×1e6).
- **H1/S1/S2 locking:** apply holds the import row `FOR SHARE` (after the month advisory lock) and re-checks READY /
  not purged / processingVersion; reprocess / cancel / delete / retention purge take `FOR UPDATE NOWAIT` → 409 "busy"
  while an apply (or the worker's final write) holds it; reprocess and delete refuse once any SalesImportApply exists.
  Helpers in `ingest/import-lock.ts`. (Purge's GCS delete moved after the commit in §10a.9.)
- **H2:** `SalesImport.mappingFingerprint` (only parse-relevant fields; labels ignored) vs the current profile → every
  month blocked ("Reprocess the file first"); profile PUT refuses removing/re-pointing the amount/quantity column while an
  enabled KPI uses that measure.
- **H3:** quantities are BigInt pico-cases (×1e12) end to end; cases are rounded ONCE, exactly, to 3 dp
  (`picoToCases`). 12 × (1/12 as an Excel float) = 1.000.
- **H4:** both measures mapped → a blank one is 0 (row kept); skipped only when both are blank.
- **M1** `stream.pipeline` for the CSV source. **M2** random `claimToken` per claim; heartbeat/finalise match it; the
  READY write (delete + insert aggregates + unmatched.csv + READY) is one transaction re-locking the row by token.
  **M3** stalled PROCESSING (> 10 min) can be reprocessed / cancelled; `POST admin/sales-import/:id/cancel`
  (QUEUED / stalled → CANCELLED + purge; a live worker stops at its next heartbeat). Scheduler call REQUIRED (§14).
- **M4** KPI tester memoises per distinct combo (shared match cache across months; entry hits once per combo); > 100,000
  combos → 400.
- **M5** D-1 guard also applies when the flag is OFF but the month holds Sales Import applies; DB error → 503 (fail
  closed, all four routes); allowed exports/reports are recorded as AuditLog `EXPORT` on `SALES_MONTH <client>:<month>`;
  reopen → 409 unless `acknowledgeDownstream` when credit batches (any status, `period`) or recorded exports exist;
  `SalesMonthRow.downstream`, `SalesMonthReopenResult.warnings`.
- **M6** the worker aggregates EVERY customer code (normalized), capped (readable FAILED; caps revised in §10a.9 /
  §7.1 step 11); preview/apply map codes onto the CURRENT roster
  (`normalizedRosterIndex`, shared with the worker). `ROSTER_CHANGED`, `rosterHashMatches` and the roster-hash helpers
  are gone (`rosterHash` column kept, unused); preview shows `rosterOutletsAddedSinceProcessing` and recomputes the
  matched/unmatched figures live.
- **M7** `ApplyRequest.processingVersion` (409 when reprocessed since preview); partial / older acks re-checked under the
  month lock against the month's current last apply.
- **UX-1** older-file warning = data recency; `MonthPreview.lastApplied.lastInvoiceDate` vs `MonthPreview.lastDate`.
- **L1** `SalesColumnMapping.decimalSeparator` ('auto' = ',' for a ';' CSV); ambiguous dot-only values in comma mode are
  invalid (never ×100). **L4** owned-tenant manual batch delete reports the rows actually removed.
- **S3** detectedHeaders = header row (or best guess) + ≤ 3 sample rows, ≤ 300 columns, ≤ 50 chars; GET :id only, samples
  only for targets:upload; list/get use explicit selects. **S4** xlsx declared unpacked size ≤ 4 GiB total and
  sharedStrings ≤ 512 MiB; CSV field 32 KiB / record 1 MiB / 5,000 columns. **S5** retention: parts, unmatched.csv,
  aggregates and sample rows purged 30 days after finishedAt (READY / NEEDS_MAPPING / FAILED / CANCELLED; lazy on list,
  on every worker / inline drain and idle drain call); UPLOADING > 24 h → CANCELLED + purged; ≤ 3 UPLOADING per tenant.
  **S6** audit rows (entityType `SALES_IMPORT`) for create-upload, complete, reprocess, delete, cancel, unmatched.csv.
  **S7** `SalesImportPartGuard` runs flag/operator/state checks before the multipart body is buffered. **S8** a late part
  → 409 without deleting stored parts (locking replaced by guarded updates in §10a.9).
- Product-set blanks: a TEXT `''` filter value is an exact "column is empty" match (save + tester); an entry whose every
  value is blank, or a non-text blank, is rejected. `SalesImportSummary.queuedAt` added.

### 10a.9 Independent re-audit fixes (backend, 2026-11-10) — binding
Contract commits `7b4677e` (reprocess-as-new) + `26dceff` (600k distinct-code cap). Same migration
`20261111120000_sales_import_hardening` (unreleased) now also adds `filesPurgedAt`, `reprocessedFromId`, and DELETES the
old aggregate rows instead of rescaling them (they belonged to imports without a fingerprint, never usable).
- **H1 decimals.** `'auto'` is decided ONCE per file from evidence in the text amount/quantity cells (`classifyDecimal`):
  a value with both separators decides by order; "0.500", "1.5", "1,234,567" → '.', "1,5", "0,500", "1.234.567" → ',';
  "2.000" / "1,234" are ambiguous. Pass 1 reads with the starting separator (',' for a ';' CSV, else '.') and collects the
  evidence; if the evidence decides the other separator the file is read again (pass 2). Evidence for BOTH, or ONLY
  ambiguous values → NEEDS_MAPPING ("choose the decimal separator"), never a guess. In explicit '.' / ',' mode a value
  whose separators contradict the mode ("1,5" in '.', "1,234.56" or "0.500" in ',') is INVALID — skipped and counted.
- **M1 / L1 / L2 — no GCS I/O inside DB transactions** (the API shares a 10-connection pool with live tenants): putPart
  checks the state, stores the part, then one guarded update (`WHERE status='UPLOADING'`, 409 otherwise, parts never
  deleted); complete verifies parts + first bytes outside any tx, then one short guarded UPLOADING → QUEUED + audit tx;
  purge marks (aggregates, sample rows, `purgedAt`) under `FOR UPDATE NOWAIT`, deletes the GCS prefix AFTER the commit
  and stamps `filesPurgedAt` (a failure is retried by the next sweep); the worker writes unmatched.csv before its final
  transaction. The part/part/complete row-lock interplay is gone.
- **M2 xlsx bombs.** The re-sequencer inflates every entry itself and hands exceljs STORED entries of exactly the
  declared size; inflating past the declared `uncompressedSize` (sheets AND sharedStrings) aborts immediately, inflating
  short is "corrupt". exceljs input errors are now caught and raced (they used to hang the worker).
- **M3.** The fingerprint ignores the outlet-NAME column. An APPLIED import whose mapping changed is no longer stranded:
  `canReprocessAsNew` + `POST admin/sales-import/:id/reprocess-as-new` create a NEW import (`reprocessedFromId`) whose
  parts are server-side GCS copies, queued like a fresh upload; the old import stays as the record. 409 when not applied
  (use Reprocess), mapping unchanged, purged, or a live re-import exists.
- **L3 D-1 guard** reads the client flag first; flag OFF and no Sales Import apply for the month → allow; if involvement
  cannot be shown because a read failed it fails OPEN (Deoleo can never get a Sales-Import 503); fail-closed (503) only
  once involvement is known. **L4** EXPORT is recorded when the response FINISHES with a 2xx (a response hook in the
  guard — no further points-compute controller edits). **L5** `combos('latest')` skips purged imports. **canCancel** is
  false for applied imports. **Memory:** §7.1 step 11 (combined entry cap, 600k codes, heap backstop).

### 10a.10 Final re-check fixes (backend, 2026-11-10)
- **H1** `xlsx-row-source.ts` `FailFast`: one error listener rejects the CURRENTLY pending `next()` through a single
  shared reference dropped after each row (the per-row `Promise.race` against a never-settling promise retained every
  row: +204 MB / 300k rows).
- **H2** auto-decimal pass 2: pass 1's aggregates are released (references nulled) before pass 2 starts, so the file's
  maps are never held twice. **L1** pass 2 resets the row/heartbeat counters and reports streamed bytes (it does not hash).
- **M1** unmatched.csv is per run: `<prefix>unmatched-<claimToken>.csv`, its key stored on the row in the READY
  transaction (`SalesImport.unmatchedCsvKey`); downloads use only the stored key.
- **M2** a part that lands after a CANCEL / purge deletes its object again (after a COMPLETE it is kept: byte-identical
  to the verified part, and the queued import needs it).
- **M3** reprocess-as-new locks the parent `FOR UPDATE NOWAIT` in the create transaction and re-checks live children;
  a partial unique index (`sales_imports_reprocessedFromId_live_key`: reprocessedFromId where status not CANCELLED /
  FAILED) is the last line (P2002 → 409). **L4** it applies the in-flight upload cap; a failed copy, or a parent purged
  during the copy, cancels the child (and marks it CANCELLED even when the purge is busy, so retries are never blocked).
- **M4** heap backstop reads `v8.getHeapStatistics()` (used vs limit, or too little available) and fails only after TWO
  consecutive over-threshold checks (10k rows apart).
- **L2** a re-import is never flagged as a duplicate of its own parent. **L5** D-1 guard: a failed flag read is retried
  once, then the last flag value this instance read decides (ON → guarded; OFF / never read → fail open).

## 10b. Month history + "Recalculate from stored history" (owner decision 2026-11-10)
**Why.** Per-import aggregates (every customer's lines) are purged 30 days after an import finishes (§14 retention), so
without a durable copy a month could never be recomputed after a KPI-definition or roster change. The owner decided to
keep exactly ONE set of lines per month — the FINAL applied one — for 10 years. **Update 2026-11-18 (sales-day-level):**
the set now holds PROGRAMME outlets only, and the windows shrink to the current month + 3 previous once
`SALES_RETENTION_V2=on` — see "Retention" below and the runbook in §17b.

**Model** (`SalesMonthHistory`, table `sales_month_histories`, migration `20261112120000_sales_month_history` — a NEW
migration so a database that already applied `20261111120000_sales_import_hardening` is not invalidated): clientId,
month, customerCode (normalized, = the aggregates' code), outletId (the roster outlet at apply time; null = unmatched),
dims + dimKey (same keys as the aggregates), amountPaise, qtyPico (same exact scales), lines, sourceImportId, appliedAt,
appliedById. Unique (clientId, month, customerCode, dimKey). No FK to sales_imports (it outlives the import's data).
`sales_import_applies.source` = `IMPORT` | `HISTORY`.

**Write.** Every APPLY of a month, inside the same transaction and month lock, DELETEs that month's history and INSERTs
… SELECTs the applying import's aggregates for the month. **Since 2026-11-18 (owner decision; write-side, no switch):
PROGRAMME outlets only** — customer codes on the roster at apply time (outletId joined from that roster; unmatched
customers are NOT stored — they stay in the import's own unmatched report while it exists), each line with its day split
(`days`). Rows written before that date may still hold unmatched customers until the one-off trim (§17b) removes them.
So history always equals the programme part of the last applied file of the month, one set per month.

**Recalculate.** `GET admin/sales-months/:month/recalculate/preview` (targets:read) → `SalesMonthRecalcPreview`: ALL
importer-owned KPIs recomputed from the history with the CURRENT definitions and the CURRENT roster (customer codes →
outlets), per-KPI new / current / delta, matched / unmatched, zero-fills, `outletsAffected`, warnings. `POST
admin/sales-months/:month/recalculate` (targets:upload, flag on, month OPEN — CLOSED / future refused, reopen stays
Gifsy-only — month lock, 409 when `expectedDefinitionsHash` / `expectedHistoryAppliedAt` are stale) rewrites
OutletSalesRecord with the SAME write as apply (full rewrite of owned keys, batch, audit) and records a SalesImportApply
with `source: HISTORY` (importId = the history's source import). The history itself is not changed by a recalculation.
`SalesMonthRow.hasHistory / historySourceImportId / historyAppliedAt` tell the UI when it is possible.

**Retention** (one place: `api/src/sales-import/retention-window.ts`; switch `SALES_RETENTION_V2`, **default OFF** — a
deploy changes no retention):
- switch OFF (default; the behaviour before 2026-11-18): per-import aggregates / raw parts / unmatched.csv 30 days after
  the import finishes (`SALES_IMPORT_RETENTION_DAYS`); month history (lines, set headers AND the §10c combos summary)
  10 years (`SALES_MONTH_HISTORY_RETENTION_YEARS`) before the current IST month;
- switch ON (`SALES_RETENTION_V2=on`, set only after the §17b runbook): per-import data 7 days
  (`SALES_IMPORT_RETENTION_DAYS_V2`); month history the current IST month + 3 previous
  (`SALES_MONTH_HISTORY_RETENTION_MONTHS` = 4; the setting `SALES_HISTORY_RETENTION_MONTHS` overrides it). Readers (Months
  list, recalculate, rebuild product list, KPI picker) treat older months as having no history even while the bounded
  sweep is still deleting them;
- day-level data (`outlet_sales_days` + `sales_day_sets`) ALWAYS keeps the current month + 3 previous, whatever the switch
  (new tables — nothing that existed before is deleted by it; the comparison needs only those months). An apply /
  recalculate of an older month stores no day data and says so (`dayData.written=false` + reason).
The sweep (list / worker drain / idle drain) deletes by these windows; the one-off trim applies the V2 windows EXPLICITLY.

**Final-check hardening (migration `20261112130000_sales_month_history_sets`, additive; backfills headers):**
- **Set header** `sales_month_history_sets` (unique clientId+month): sourceImportId, appliedAt, appliedById, the
  `mappingFingerprint` and `dimensionKeys` the lines were parsed with, lineRows. Written in the apply transaction. Month
  lists (`SalesMonthRow.hasHistory…`) and recalculate read ONLY this table — never the line rows (Prisma `distinct` is
  applied in Node after fetching every row, so it is not used on large tables anywhere in the module; the other two
  former uses — applies per import, outlet segment options — are SQL `groupBy` now).
- **Recalculate vs mapping drift:** an enabled KPI filtering on a dimension key the stored set lacks → `canApply=false`
  with the KPI and key named (the POST refuses too); a different mapping fingerprint with every used key present →
  `MAPPING_CHANGED` warning only.
- **Bounded keys:** history uniqueness is `(clientId, month, keyHash)` with `keyHash = md5(customerCode ‖ chr(31) ‖
  dimKey)`; ingest skips (and counts) rows whose dimension value or outlet code exceeds
  `SALES_IMPORT_MAX_DIM_VALUE_CHARS` (200).
- **Totals (real-DB finding 2):** every KPI "new" total (preview, apply audit `after`) is the sum of the per-outlet values
  actually STORED (paise / thousandths of a case, each rounded once) — an identical re-apply shows Δ 0.
- **Time zones (real-DB finding 3):** raw SQL never uses a bare `now()`: `sql-time.ts` provides `(now() AT TIME ZONE 'UTC')`
  and UTC-converted JS dates for the TIMESTAMP(3)-without-zone columns (claim / heartbeat staleness, month writes, owned
  manual-upload writes); `sql-time.spec.ts` fails on any bare now() / CURRENT_TIMESTAMP in the module.
- **Month-write budget:** apply / recalculate transactions have an explicit `APPLY_TX_TIMEOUT_MS` = 300 s; the history
  DELETE + one set-based INSERT … SELECT log `{msg:'sales-import month history written', deletedRows, insertedRows,
  deleteMs, insertMs}` so the real-scale timing can be measured and the bound adjusted.

## 10c. Extras (branch `feat/sales-import-extras`, 2026-11-10; audit fixes + lead decision same day)
**KPI product picker from stored month history.** `GET admin/sales-import/history-combos?month=YYYY-MM` or
`?lastMonths=N` (1..`SALES_HISTORY_COMBOS_MAX_MONTHS` = 12, default 1; never both) — targets:read + the feature-flag gate
(`assertSalesImportAccess`), tenant-scoped, on the config controller (static segment, before `GET :id`). "Last N" = the N
most recent months WITH stored history (read from `sales_month_history_sets`, not calendar months). Response
`SalesHistoryCombos` = the `SalesImportCombos` lists (`dimensionCombos` + `dimensionValues`, same caps: top 2,000 combos /
200 values per key by |₹|) + `months`, `availableMonths` (newest first, for the picker), `dimensionKeys` (union of the
covered sets' keys), `dimensionKeysDiffer`, `totalCombos` (uncapped distinct count), `unavailableMonths` (see below).
- **Combos summary (audit M1).** New table `sales_month_history_combos` (migration
  `20261112140000_sales_month_history_combos`, additive, backfills every stored month): one row per (tenant, month,
  product combo) — clientId, month, dims, dimKey, `keyHash = md5(dimKey)` (unique with clientId + month), amountPaise /
  qtyPico as NUMERIC(38,0) (a month total can exceed BIGINT pico-cases), lines, and the history set it summarises
  (`sourceImportId`, `appliedAt`). Every APPLY replaces the month's rows in the SAME transaction, right after the history
  INSERT, with ONE `INSERT … SELECT … FROM sales_month_histories WHERE month GROUP BY dimKey, dims` (`kpi/month-combos.ts`;
  dimKey is 1:1 with dims; the apply log line adds `comboRows`, `combosMs`), and stamps the set header
  (`combosSourceImportId` / `combosAppliedAt`) in the same upsert. Recalculate does not change the history, so it does
  not touch the summary. The history retention (10 years; current month + 3 previous with `SALES_RETENTION_V2=on`, §10b)
  deletes summary rows with the history. Since 2026-11-18 the summary covers PROGRAMME outlets only (like the history).
- **No background rebuild (lead decision 2026-11-10); an explicit "Rebuild product list" instead.** A summary can only be
  missing or out of date if an OLDER revision applied a month during the rolling deploy that introduces this table (no
  prod tenant has `salesImport` on; staging pushes are controlled), so there is no repair job. The earlier
  background-rebuild design (worker / Scheduler drain, try-lock, failure rotation) was removed after audit — it held the
  month advisory lock for minutes and could starve or never run. Re-applying a month is NOT the fix (it rewrites
  achievements and can be refused / purged / closed), so: `POST admin/sales-months/:month/rebuild-product-list`
  (targets:upload, flag gate, audited `SALES_MONTH` / `rebuild-product-list`) — in ONE transaction with
  `SET LOCAL statement_timeout = 240000` and a 280 s bound (apply scale), under the SAME blocking month lock as apply
  (`lockSalesMonth`): DELETE the month's summary, the same INSERT … SELECT from `sales_month_histories`, re-stamp the
  header from its own source. Allowed for OPEN and CLOSED months — it changes no achievement, KPI value or history line.
  404 without history, for a month below the history retention cutoff (§10b), or when the header was purged meanwhile (the
  stamp is an `updateMany`; count 0 → 404 and the transaction rolls back); a statement timeout (e.g. the lock wait
  behind a long apply) → 409 "busy, try again".
  `SalesMonthRow.productListCurrent` (false only with history and a summary not from it) drives the Months-page button.
- **Migration note.** `20261112140000` was EDITED IN PLACE several times on this branch; as of 2026-11-10 it existed only
  on local branches; since 2026-11-11 its FINAL version is on `develop` and applied to the staging DB (not on `main`/prod). It
  must not be edited again. **A local DB that applied an older version must be reset** (`prisma migrate reset`
  on the local dev DB) before applying this one.
- **Read path = strictly read-only.** GET history-combos runs ONE `SET TRANSACTION READ ONLY` transaction under
  `SET LOCAL statement_timeout = 10000` (`HISTORY_COMBOS_STATEMENT_TIMEOUT_MS`; tx bound 45 s): the set headers (with their
  stamp) are read INSIDE it, then two aggregate statements ONE AFTER THE OTHER. It never writes and never takes the month
  lock. Per month (from the header stamp, no summary scan): **current** → the summary; **missing or stale** → the stored
  lines (read-only), newest month first, while those months' line rows SUM to ≤ `HISTORY_COMBOS_LINE_FALLBACK_MAX_ROWS`
  = 50,000; the rest → `SalesHistoryCombos.unavailableMonths` (no combos). Months below the history retention cutoff (§10b)
  (being deleted by the sweep) are never offered or read. 503 copy: statement timeout, or a P2028 for an
  expired / already-closed transaction → "Reading the stored months took too long. Try fewer months, or try again in a
  few minutes."; any other P2028 (no transaction could start) → "The server is busy right now. Try again in a moment."
- **FE:** the product-set builder has a source selector (Latest file / Stored month(s) → most recent, last 3/6/12, or one
  month); a change of the month select is debounced 300 ms and a superseded request is aborted (`historyCombos(q,
  signal)` uses plain fetch with the shared client's error conventions — 403 → "You don't have permission to do that" —
  because adding a signal to the SHARED `api.get` is a platform-wide change held for the owner's approval). Combos pin
  only the keys their stored lines carry (`comboEntry`, unchanged rule); a drift note compares the stored
  `dimensionKeys` (fallback: the combos' keys) with the current mapping and flags months read with different columns;
  the live "never appears" check uses the selected source and is off when the list is capped (`totalCombos >
  dimensionCombos.length`, or ≥ 2,000 for the file). "Test" still runs against the latest file (copy says so). Months in
  `unavailableMonths` get a status notice "The product list for <month> isn't available — open Months and choose
  'Rebuild product list' (it doesn't change any figures)." (plural: "The product lists for … aren't available … for
  each"; the link is `/admin/sales-import/months?from=<oldest unavailable>&to=<newest unavailable>` — or
  `?from=<newest>` when the span exceeds the page's 36-month range — and the Months page lists that range, `to`
  clamped at the current IST month, so every unavailable month's button is visible). The Months page shows "Rebuild product list" (confirm → result message, row updated) on each month with history
  whose `productListCurrent` is false, OPEN or CLOSED, for targets:upload. No polling, no time promise.
- **Retention bounds (the idle Scheduler drain).** The drain sets `deadline = start + DRAIN_DEADLINE_MS (150 s)` and
  passes it to `sweep({deadline})`, which starts a step only if its worst case still ends by then: a purge
  (`PURGE_STEP_MS` = 120 s tx + 10 s lock wait + 15 s GCS) — inside it every statement runs under
  `SET LOCAL statement_timeout = 100000`; a GCS retry (20 s); the month-window history + day-data delete (45 s). The GCS prefix delete is
  abandoned after `GCS_DELETE_TIMEOUT_MS` = 15 s (the GCS client takes no abort signal, so the request itself is not
  cancelled; `filesPurgedAt` stays null and the next sweep retries). The month-window history + day-data delete is one transaction with
  `statement_timeout = 12 s`, at most 50,000 line rows and 50,000 summary rows per call (headers go once a month's lines
  and summary are gone), so a large backlog drains over several sweeps; it runs only on the drains / worker sweeps, never
  on the import-list GET. That GET's inline sweep passes `history: false` and `stopStartingAfter` = now + 10 s (no new
  step after that; a started step keeps its own bounds). A GCS prefix whose delete is still in flight (timed out on our
  side, not yet settled in the client) is skipped (in-memory set) instead of being deleted twice.
- Not verified against a real DB yet (SQL unit-tested for shape only) — run the migration + picker on staging before
  relying on it; check the `comboRows` / `combosMs` apply log at real scale.

**Graceful worker stop.** Cloud Run Jobs send SIGTERM, then SIGKILL ~10 s later. `ingest/worker-stop.ts` (no imports;
loaded before the heap decision): on SIGTERM / SIGINT the worker stops claiming (`drainImports`), the processor destroys
the current input stream and RELEASES its claim — `updateMany WHERE id, status PROCESSING, claimToken` → `QUEUED`,
`claimToken`/`heartbeatAt`/`startedAt` null, progress 0 (`queuedAt` kept). The stop itself never marks it FAILED (any error
after a stop request is released, not failed).
- **Attempts (audit H1).** Only an EARLY stop (within `STOP_RESTORES_ATTEMPT_WITHIN_MS` = 10 min of the run's start — a
  deploy / scale-down) restores `attempts` to its pre-claim value. A later stop (e.g. the 3600 s task timeout on a file
  that never finishes, or a stalled read) COUNTS the attempt, so after `SALES_IMPORT_MAX_ATTEMPTS` the next claim ends it
  FAILED: "Processing was attempted N times without finishing (it took too long or was stopped repeatedly)…". Without
  this an always-timing-out import would be handed back forever and block every later import (claims are oldest-first).
- The READY transaction is a critical section: a stop arriving during it is ignored (it commits; a SIGKILL rolls it back
  whole); the forced exit at `WORKER_STOP_DEADLINE_MS` = 8 s is skipped while it runs, and when it ends after the deadline
  a `WORKER_STOP_AFTER_CRITICAL_MS` = 1 s forced exit is re-armed (audit L2).
- A stopped worker exits `WORKER_STOP_EXIT_CODE` = 143 (also after a clean release) so Cloud Run's task retry picks the
  handed-back import up promptly (audit L1); the retention sweep is skipped when stopping. The final log reports
  `finished` / `released` / `superseded` separately (`processClaimed` returns the outcome; audit L3).
- The heap re-exec parent forwards SIGTERM / SIGINT to the child and mirrors its exit code. No infra change. (The inline
  runner in the API process is unchanged: a killed inline run is still recovered by the stale-heartbeat reclaim.)

## 11. Lane tasks (TDD: write the test first, see it fail, implement, see it pass; run `cd api && npx jest src/sales-import` or `cd platform && npx vitest run src/app/admin/sales-import src/lib/sales-import`)

### Lane I — Backend ingest (owner of `api/src/sales-import/ingest/**`, `worker.main.ts`, runner, upload endpoints)

**I-0 Dependency (D-3).** `cd api && npm install exceljs@4.4.0` (pin exact; it lands in `dependencies`). Add to
`api/Dockerfile` after `RUN ls dist/main.js`: `RUN ls dist/sales-import/worker.main.js`. In the runner stage, after
`npm ci --omit=dev`, add `RUN node -e "require.resolve('exceljs')"` (boot-crash guard). Verify: `docker build ./api`
succeeds (or CI). Import exceljs ONLY in `ingest/xlsx-row-source.ts`.

**I-1 Normalizers** `ingest/normalize.ts` + spec. Tests (table-driven):
```ts
it.each([[' customer  code ', 'CUSTOMER CODE'], ['\uFEFFCODE', 'CODE']])('normalizeHeader(%p)', (i, o) => expect(normalizeHeader(i)).toBe(o));
it.each([[500, '500'], [500.0, '500'], [' cno  enrich ', 'CNO ENRICH'], ['', '']])('normalizeDim(%p)', (i, o) => expect(normalizeDim(i)).toBe(o));
it.each([['1,234.50', 123450n], [-12.345, -1235n], ['₹ 10', 1000n]])('toPaise(%p)', (i, o) => expect(toPaise(i)).toBe(o));
it('toMicro keeps fractional cases', () => expect(toMicro('0.04')).toBe(40000n));
it.each([['05-10-2026','DMY','2026-10-05'], ['05/Oct/2026','DMY','2026-10-05'], [46300,'DMY','2026-10-05'] /* serial */,
         ['2026-10-05','YMD','2026-10-05']])('parseInvoiceDate(%p,%p)', (v, ord, out) => expect(parseInvoiceDate(v, ord as any)).toBe(out));
it('rejects 31-02-2026', () => expect(parseInvoiceDate('31-02-2026','DMY')).toBeNull());
it('normalizeOutletCode(327852.0) → "327852"', () => expect(normalizeOutletCode(327852)).toBe('327852'));
```
(Compute the serial in the test from `Date.UTC`; never hardcode a "future" date relative to now. The parse-window check uses an
injected `today`.)

**I-2 Header resolution** `ingest/header.ts`: `resolveHeader(rows: unknown[][], mapping) → {headerRowIdx, colIdx:{outletCode,…,dims:{key:idx}}} | {needsMapping:true, reason, missing[], duplicates[]}`.
Tests: auto-detect skips a marker row of `X`s above the header; a fixed `headerRow`; a missing header → `missing:['INVOICE DATE']`;
duplicate header → `duplicates`; "CODE" vs "CUSTOMER CODE" both present → resolved to distinct columns; order-independence (shuffled columns).

**I-3 CSV streaming parser** `ingest/csv-row-source.ts`: `async function* csvRows(stream: Readable, delimiter?: string): AsyncGenerator<string[]>`.
Tests: quoted comma, `""` escape, embedded newline in quotes, CRLF, BOM, delimiter auto-detect `;`, a 1-byte-chunked stream
(feed via `Readable.from(Buffer.from(s).toString().split(''))`) gives identical rows.

**I-4 XLSX streaming source** `ingest/xlsx-row-source.ts`: `async function* xlsxRows(stream, sheetName?)` yields `unknown[]`
(dense array; `row.values` is 1-based, so shift it). Dates come through as `Date`. Test with a fixture built in-test using
SheetJS `XLSX.write` (already a dep) with 3 header-ish rows + 50 data rows incl. a date-formatted cell, a numeric code and a
fraction. Also an exceljs-generated fixture for shared strings.

**I-5 Aggregator (pure)** `ingest/aggregator.ts`: `class SalesAggregator { constructor(mapping, colIdx, roster: Map<string, OutletMeta>, todayIso) ; push(row: unknown[], rowNo: number): void ; result(): AggregatorResult }`.
Tests:
```ts
it('nets returns within a month and splits by invoice month', () => {
  const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
  a.push(row('O1','2026-10-03','X','500','100.00','1.5'), 3);
  a.push(row('O1','2026-10-20','X','500','-40.00','-0.5'), 4);
  a.push(row('O1','2026-11-01','X','500','10.00','0.04'), 5);
  const r = a.result();
  expect(r.aggs.get('2026-10|O1|{"dimA":"X","dimB":"500"}')).toEqual({ amountPaise: 6000n, qtyMicro: 1000000n, lines: 2 });
  expect(r.months.get('2026-11')!.firstDate).toBe('2026-11-01');
});
it('counts unmatched customers per month without aggregating them', …);
it('skips blank code / bad date / bad amount with reasons, capped at 200 samples', …);
it('dimensionValues keeps per-dim counts (top 200)', …);
it('dimensionCombos lists every distinct full combo with lines/₹/qty (cap 2,000, sorted by |₹|)', …);
```

**I-6 Processor service** `ingest/sales-import-processor.service.ts`: `processClaimed(importRow)` orchestrates §7.1 steps 2–10.
It uses `PrismaService`, `StorageService` (add `openReadStream(key)` + `listPrefix(prefix)` + `deletePrefix(prefix)` +
`uploadStream(key, readable)` to `storage.service.ts`, additive and tested with a mocked bucket) and the pure parts above.
Spec with mocked prisma/storage: READY path writes aggregates in 5k chunks + summaries; NEEDS_MAPPING path; FAILED path keeps the
error message; reprocess deletes old aggregates first; duplicate sha sets `duplicateOfId`; flag-off → FAILED.

**I-7 Claim loop and worker entry** `ingest/claim.ts` (raw SQL of §7.1.1, with a spec against mocked `$queryRaw`) and
`api/src/sales-import/worker.main.ts`:
```ts
// (as built, §10c: heap re-exec + SIGTERM handling around this; see worker.main.ts / ingest/worker-stop.ts)
async function main() {
  const stop = new WorkerStop(); installWorkerSignals({ stop, on, exit, log });
  const app = await NestFactory.createApplicationContext(SalesImportWorkerModule, { bufferLogs: true });
  const proc = app.get(SalesImportProcessorService);
  const drained = await drainImports(proc, stop); // { finished, released, superseded }
  const retention = stop.requested ? null : await app.get(SalesImportRetentionService).sweep({ limit: 50 });
  await app.close();
  console.log(JSON.stringify({ msg: 'sales-import worker done', ...drained, retention, stoppedBy: stop.reason }));
  if (stop.requested) process.exit(143);
}
main().catch((e) => { console.error(e); process.exit(1); });
```
`SalesImportWorkerModule` imports only `ConfigModule.forRoot({isGlobal:true})`, `PrismaModule`, `StorageModule`,
`TenantModule` (for the flag read), and the processor.

**I-8 Runner** `ingest/sales-import-runner.service.ts`: `kick(): Promise<'inline'|'job'|'none'>`.
`SALES_IMPORT_RUNNER=inline` → `setImmediate(() => worker loop in-process)` (local dev/e2e). `=job` → metadata token
(`GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`, header `Metadata-Flavor: Google`)
→ `POST https://run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/jobs/${SALES_IMPORT_JOB}:run`. Unset/any
error → log warn, return `'none'` (the import stays QUEUED; drain endpoint and Cloud Scheduler recover it). Must never throw to the
caller. Spec: mock `global.fetch`; asserts the URL, `Authorization: Bearer`, the failure → 'none'. Env names are added to the
deploy steps (§14).

**I-9 Upload endpoints** (`sales-import.controller.ts`, upload part): `POST uploads`, `POST :id/parts/:n` (`FileInterceptor('file',
{limits:{fileSize: 4*1024*1024 + 64*1024}})`; `n` integer within `[0, partCount)`; import must be UPLOADING and same tenant, else 404),
`POST :id/complete` (list parts → sizes sum == sizeBytes and count == partCount; first part magic check: `PK\x03\x04` ⇒ XLSX must
match `.xlsx`; CSV must be valid UTF-8 text in the first 4 KiB) → QUEUED → `runner.kick()`. `POST :id/reprocess`, `DELETE :id`
(never-applied only), `POST sales-import/drain` (`@Public`, constant-time secret compare, fail-closed; copy `kyc.controller.ts:236-245`).
Controller specs: cross-tenant importId → 404; wrong state → 409; size mismatch → 400; drain without secret → 403.

**I-10 Read endpoints:** `GET sales-import`, `GET :id` (progressPct), `GET :id/unmatched.csv` (stream from GCS), `GET :id/errors.xlsx`. Specs.

### Lane K — Backend KPI / month / apply / ownership / engine glue (owner of `api/src/sales-import/kpi/**`, `months/**`, `apply/**`, the targets edits, the D-1 guard)

**K-1 Profile CRUD** `kpi/sales-profile.service.ts`: validate the mapping (dims keys regex/unique, headers non-empty + unique after
normalize, ≥1 of amount/quantity) → upsert → audit `UPDATE` `entityType:'SALES_IMPORT_PROFILE'`. Spec: each validation error; audit written.

**K-2 KPI definitions** `kpi/sales-kpi-def.service.ts`: create/patch/disable. Validate `kpiCode` is an **enabled KpiDef** of the
tenant (`prisma.kpiDef.findFirst({where:{clientId, code, enabled:true}})`, same check as `offers-admin.service.ts:146-153`).
Filter keys must be ⊆ profile dimension keys. Values are normalized with `normalizeDim` (import from Lane I's `normalize.ts`;
Lane-0 creates the file with the function signatures so both lanes compile). `measure` ∈ AMOUNT|QUANTITY; when the profile has no
amount/quantity column the matching measure → 400. Audit CREATE/UPDATE/DELETE with old/new JSON. `definitionsHash()`. Specs incl.
"409 when kpiCode already owned by another enabled definition".

**K-3 KPI evaluation (pure)** `kpi/sales-kpi.helper.ts`: `lineMatches`, `computeOutletKpis(aggsForOutlet, defs, outletMeta) → Record<kpiCode, number>`
(scope-omits; zero-fills in-scope). Tests: the 5 generic examples of §6.2; noneOf + anyOf combined; case/space-insensitive values;
out-of-scope outlet → key absent; in-scope with no lines → 0; AMOUNT `Number(6000n)/100 === 60`; QUANTITY `0.04` survives.
Multi-combo tests (§6.2a), fixtures in neutral names:
```ts
const aggs = [
  agg({ dimA: 'P', dimB: '500' }, 10000n, 1_000000n), agg({ dimA: 'P', dimB: '200' }, 4000n, 500000n),
  agg({ dimA: 'P', dimB: '150' }, 2500n, 250000n),   agg({ dimA: 'P', dimB: '50'  }, 999n, 90000n),
  agg({ dimA: 'Q', dimB: '500' }, 7000n, 700000n),   agg({ dimA: 'Q', dimB: '50'  }, 300n, 30000n),
];
const SET = { anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'P', dimB: '200' }, { dimA: 'P', dimB: '150' }] };
it('sums ₹ across a 3-combo set', () => expect(kpi(aggs, 'AMOUNT', SET)).toBe(165));            // (10000+4000+2500)/100
it('sums cases across the same set', () => expect(kpi(aggs, 'QUANTITY', SET)).toBe(1.75));
it('mixes a whole-brand entry with combos across brands', () =>
  expect(kpi(aggs, 'AMOUNT', { anyOf: [{ dimA: 'Q' }, { dimA: 'P', dimB: '500' }] })).toBe(173)); // 7000+300+10000
it('counts a line matching TWO entries once (overlap)', () =>
  expect(kpi(aggs, 'AMOUNT', { anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'P' }] })).toBe(174.99)); // all P once
it('exclusion inside a whole brand', () =>
  expect(kpi(aggs, 'AMOUNT', { anyOf: [{ dimA: 'P' }], noneOf: [{ dimA: 'P', dimB: '50' }] })).toBe(165));
it('not-equal brand = noneOf only', () => expect(kpi(aggs, 'AMOUNT', { noneOf: [{ dimA: 'P' }] })).toBe(73));
it('entry order and duplicates do not change the result', …);
it('normalizes entry values (" p ", "500.0")', …);
it('reports entries matching no line as unmatchedEntries and covered entries as redundantEntries', …);
it('rejects an empty entry {} in anyOf and > 200 entries', …);
```

**K-4 Month state (pure + service)** `months/month-state.ts` `resolveMonthState(month, current, override)` with an exhaustive table test
(future/current/previous/older × override none/OPEN/CLOSED). Compute "current" from `currentMonthKey()` and inject it; tests derive
months relative to `new Date()` (date-relative-tests rule). `months/sales-months.service.ts`: list/close/reopen with advisory lock + audit.
Specs: close current → 409; close previous → CLOSED; CLIENT_ADMIN reopen → 403 (role guard); GIFSY_ADMIN un-assumed → 400; reopen older → OPEN.

**K-5 Preview** `apply/sales-preview.service.ts`: for each month in `monthSummaries`, page aggregates by `(importId, month, id > cursor)`
20k at a time → per-outlet accumulators → `computeOutletKpis` → totals. Current totals: `outletSalesRecord.findMany({where:{clientId,
month}, select:{outletCode,kpiValues,batch:{select:{status:true}}}})` → Σ owned keys; `REPLACES_MANUAL_VALUES` when any owned key sits
on a row whose batch status ≠ SALES_IMPORT. Plus warnings and canApply (§6.3, §7.3). Spec with a mocked prisma: deltas, all warnings,
roster-changed blocks apply, closed month blocked.

**K-6 Apply** `apply/sales-apply.service.ts` (§7.2). Specs (mock `$transaction` callback with a fake tx): lock taken first; closed
month → `ok:false` without writes; hash mismatch → 409 before any tx; missing partial ack → 400; owned list passed to SQL; batch created
with status SALES_IMPORT; audit written; one month failing → others still ok. **Plus an integration spec against a real Postgres**
(`api/test/sales-import-apply.e2e-spec.ts`, runs under `npm run test:e2e` with the local DB; skipped when `DATABASE_URL` is absent).
It seeds 3 outlets + a row holding `{MANUAL_K: 5, OWNED_K: 1}` and asserts that after apply `MANUAL_K` is still 5, `OWNED_K` is the new
value, an absent outlet is 0, an off-roster row lost `OWNED_K`, and `batchId` of the existing row is unchanged.

**K-7 Manual-upload ownership (§7.4)** edits to `targets.service.ts`. Tests in `targets.service.spec.ts`:
- **byte-identical guard:** with `salesKpiDefinition.findMany → []`, `uploadAchievements` issues exactly the same `outletSalesRecord.upsert`
  args as before (snapshot the mock call args against the existing fixture; also assert the existing `findMany` is NOT called).
- owned `['OWNED_K']`: an OWNED_K column in the file → not written, `skippedImporterOwnedKpis:['OWNED_K']`; an existing row's OWNED_K preserved.
- template excludes owned columns; unchanged when none owned.
- `deleteAchievementBatch` SALES_IMPORT → 409; manual batch with owned keys on rows → manual keys stripped, owned kept, batchId repointed;
  no owned → existing cascade path unchanged.

**K-8 D-1 guard (only if owner picks A)** `months/sales-month-closed.guard.ts` (`CanActivate`): reads `period` from body or query; if
tenant `features.salesImport === true` and `resolveMonthState(period) === 'OPEN'` → `ConflictException`. Else allow. Add
`@UseGuards(SalesMonthClosedGuard)` at `points-compute.controller.ts:54,79,105,127`. Import `SalesImportModule` exports in
`points-engine.module.ts`, or provide the guard via a tiny `SalesMonthsCoreModule` to avoid circular imports. Specs: flag off → allow (Deoleo);
open → 409; closed → allow; preview route NOT guarded. Existing points-engine jest must stay green, untouched.

**K-9 Engine-compat proof (no engine edits).** `api/src/sales-import/engine-compat.spec.ts`: import `evaluateRule`/`validateRule`
from `points-engine.helper.ts`. Feed the §9 JSON (with `fieldId:'f1'`) and contexts built from `computeOutletKpis` output:
(cases 37.9, ₹ 120% of target, WHOLESALER) → 370; (₹ 99%) → 0; (no target) → 0; (SSS) → 0; (cases 9000) → cap 50000. `validateRule` → `[]`.

### Lane F — Frontend (owner of `platform/src/app/admin/sales-import/**`, `platform/src/lib/sales-import/**`, the nav entry, the achievements-page tweak)
**First read `platform/AGENTS.md` and the relevant guides in `platform/node_modules/next/dist/docs/`** (this Next is non-standard).
Patterns to copy: route guard + feature gate `app/admin/offers/layout.tsx` + `_components/offers-feature-gate.tsx`; stepper/summary
cards `app/admin/credits-payouts/upload/page.tsx`; hand-rolled tables, `bg-white rounded-xl border-gray-200`, `var(--brand-primary)`,
lucide icons; `api` client (`lib/api-client.ts:69-75`); native `confirm()` for destructive actions. No new libs.

**F-1 lib** `lib/sales-import/api.ts` (typed wrappers for §5.2) and `lib/sales-import/upload.ts`:
```ts
export async function uploadInParts(file: File, opts: { onProgress(p: number): void; signal?: AbortSignal }): Promise<string> {
  const init = await api.post<{ importId: string; partSize: number; partCount: number }>('/api/admin/sales-import/uploads',
    { filename: file.name, sizeBytes: file.size });
  if (!init.success) throw new Error(init.error);
  const { importId, partSize, partCount } = init.data;
  for (let n = 0; n < partCount; n++) {
    const blob = file.slice(n * partSize, Math.min(file.size, (n + 1) * partSize));
    await withRetry(() => postPart(importId, n, blob, opts.signal), 4);   // 0.5s,1s,2s,4s backoff; abort-aware
    opts.onProgress((n + 1) / partCount);
  }
  const done = await api.post(`/api/admin/sales-import/${importId}/complete`, {});
  if (!done.success) throw new Error(done.error);
  return importId;
}
```
`postPart` uses `fetch` with `FormData` + `authHeader()` (`api-client.ts:24`), like `admin/targets/upload/page.tsx:226`.
Tests: slicing math (exact last part), retry then success, abort stops, `complete` error is surfaced.

**F-2 Shell:** `app/admin/sales-import/layout.tsx` (`RequireAuth allowedRoles={['GIFSY_ADMIN','CLIENT_ADMIN']}` + feature gate on
`salesImport`); nav item in `app/admin/layout.tsx` near `:189`:
`{ href: '/admin/sales-import', label: 'Sales Import', icon: FileSpreadsheet, featureFlag: 'salesImport' as const }`.
Test: hidden when the flag is off (copy `__tests__/offers-nav.test.tsx`).

**F-3 Imports list + upload** `page.tsx`: dropzone (.xlsx/.csv, ≤ 600 MB) with the G5 limit text ("one row per invoice line…"),
upload progress bar (parts), then a redirect to `[id]`. Below it, a list of imports (status chips, filename, size, rows, created by, duplicate badge).
States: loading/empty/error/retry; double-submit guard; leave-page `beforeunload` warning while uploading.

**F-4 Import detail** `[id]/page.tsx`: poll `GET :id` every 2 s while QUEUED/PROCESSING (stop on unmount/terminal; ignore stale responses
via a request seq); progress = bytes% + rows. NEEDS_MAPPING → link to Settings with detected headers. FAILED → message + Reprocess.
READY → **month table**: checkbox (disabled with `blockedReason` when !canApply), month, date range, lines, matched outlets, unmatched
customers (download link), ₹ and cases totals, per-KPI new/current/delta (expandable), warning chips with plain-English text. Partial-month
months need an explicit "I understand this replaces the whole month with this partial file" checkbox per month. Older-import warning needs
its own ack. Apply button → `confirm()` summary → POST apply with `expectedDefinitionsHash` → per-month result cards. A 409 hash mismatch
→ "KPI definitions changed; preview refreshed" + auto-refetch. Duplicate-file banner when `duplicateOfId`.

**F-5 Months** `months/page.tsx`: last 6 months table (state, last applied, closed by/at). Close button (`confirm`: "Closing locks
May 2026. Points can then be computed. Only Gifsy can reopen."). Reopen visible only to GIFSY_ADMIN.

**F-6 Settings** `settings/page.tsx`: column mapping form (header selects populated from the latest import's `detectedHeaders` when
present, else free text), dimension rows (key/label/header), header row auto/fixed, date order. KPI definitions table + editor: KPI select
from `/api/admin/kpis` (enabled; label + unit), measure radio, the **Product set builder** of §6.2a (combo picker from
`GET :id/combos` with `latest`, whole-brand chips, free entry, Exclude tab, chips view, "Duplicate as cases KPI"), outlet-type/program
multi-select, and a **Test against latest import** button (`POST kpis/test`) showing per-month ₹ and cases totals plus amber
"never appears in the latest file" / "already included by …" warnings on the offending chips. Tests: picking 3 combos produces the
expected `anyOf`; whole-brand chip; free entry normalizes; unmatched-entry warning renders on the right chip; save is blocked on an
empty entry. Ownership note: "This KPI will no longer be accepted
from the manual achievement upload."

**F-7 Achievements page tweak** (`app/admin/sales/page.tsx`, the existing achievements upload/batches UI): show
`skippedImporterOwnedKpis` as an amber notice after upload, and hide the Delete action for batches with `status === 'SALES_IMPORT'`
(label "Sales Import"). Both render nothing for tenants without such data. Test: `__tests__/page-wiring.test.ts` stays green, plus a new
test for the notice/hidden delete.

Every page gets a `__tests__/*.test.tsx` (vitest + RTL). Follow the RTL flake rules (findBy for async, no wall-clock budgets) from
memory `rtl-suite-load-flakes`.

---

## 12. Deoleo byte-identical guarantee

| Touchpoint | Why Deoleo (and every tenant without the flag/definitions) is unchanged | Proof |
|---|---|---|
| Migration | Additive `CREATE TABLE` only; no existing table altered | SQL review in P2 |
| New routes | 403 when `features.salesImport !== true`; Deoleo's flag is absent → false | access spec (0-4) |
| Manual achievement upload / template / batch delete | Every new branch is under `owned.length > 0`; Deoleo has 0 `SalesKpiDefinition` rows. The SALES_IMPORT 409 can't fire (no such batches) | K-7 byte-identical snapshot test |
| Points engine | No evaluator, compute or response change. D-1 guard (if approved) returns early when the flag is off | K-8 spec + existing points-engine jest untouched |
| Consumers of `kpiValues` | No code change | grep list §1 |
| Console + FE flag | New boolean defaults false; nav item hidden; achievements page notice renders only with data | vitest 0-3, F-2, F-7 |
| Deploy | API service flags unchanged; a NEW job is added (D-4); worker image = same api image | deploy diff review |
| Dependencies | `exceljs` added (D-3); imported only by the worker parser, not on the API request path | I-0 boot guard |

Before push: run the e2e harness (`platform/e2e`, memory `e2e-harness`) Deoleo smoke specs. They must stay green.

---

## 13. Verification

### 13.1 Local runtime (P4, before any push)
`SALES_IMPORT_RUNNER=inline`. Enable `salesImport` on a local test tenant (not Deoleo). Real login per role: GIFSY_ADMIN assumed,
CLIENT_ADMIN, MIS_USER (must be denied writes), CLIENT_ADMIN of another tenant (cross-tenant importId → 404). Synthetic file →
upload → READY → preview → apply → check My Targets/target card show the values → close → engine preview/export for the closed month →
open month export → 409 (if D-1=A). Screenshot evidence for each step.

### 13.2 Staging checklist (owner approves push + infra first)
_Status 2026-11-11: infra + real-file ingest DONE on staging (`7c85d9fd`); apply / close / engine steps WAIT for the bajaj importer-owned
KPIs (owner D-8/D-9). Synthetic-file steps not run on staging (covered by tests + the local runtime pass)._
- [x] Job `gifsy-sales-import-staging` deployed; API env `SALES_IMPORT_RUNNER=job`, `SALES_IMPORT_JOB`, `GCP_PROJECT`; IAM binding applied (2026-11-11).
- [x] Deoleo staging login renders its own branding; `salesImport` stays OFF for deoleo (achievement-upload/engine smoke not re-run).
- [ ] Bajaj staging: `salesImport` ON ✅; mapping entered ✅ (CUSTOMER CODE / CUSTOMER / INVOICE DATE / NET AMT / QTY (CASES); dims CODE→brand, CLUB SKU→skuGroup); KpiDefs (D-9) + definitions ⏳ owner.
- [ ] **Synthetic small file** (generator `api/scripts/make-synthetic-sales.ts`, CSV + xlsx, ~2k lines over 2 months, real staging outlet codes +
      50 unknown codes + returns + a partial month starting the 5th + 3 bad dates). Expect exact totals (the generator prints them) and
      exact unmatched/skip counts, all warnings visible, partial-month ack required.
- [ ] Re-upload the same synthetic file → `duplicateOfId` banner; apply again → values identical (idempotent).
- [ ] Apply, then manual achievement upload with an owned KPI column → `skippedImporterOwnedKpis` notice; owned values unchanged; non-owned values updated.
- [ ] Delete that manual batch → manual keys gone, owned keys intact.
- [ ] Close previous month → can't tick it; CLIENT_ADMIN can't reopen; GIFSY_ADMIN reopens → audit rows present for apply/close/reopen.
- [~] **Real file — INGEST DONE 2026-11-11** (214.7 MB, 52 parts; job 8 m 28 s; READY `6b681de7…`; totals in the status header; Oct matched 4,874 outlets). Apply time + dashboards ⏳ (no importer-owned KPIs yet). Original item: **Real file (~200 MB, 635k rows), uploaded by the owner through the UI** (the file is not in the repo): upload time, job duration,
      peak memory (Cloud Run job metrics), matched ≈ 77% of programme outlets, ~199k unmatched customers, month split correct, ₹ totals tie to
      the DMS file's own pivot (owner supplies the control totals per month), apply time per month < 30 s, dashboards render.
- [ ] Engine: author the §9 rule (draft → simulate → publish), close the month, preview → export; spot-check 5 wholesalers by hand
      (floor(cases) × rate, gate at 100%).
- [ ] Unhappy paths: kill the job mid-run (cancel execution) → heartbeat-stale reclaim on the next kick; a corrupted xlsx → FAILED with a
      readable message; a wrong mapping → NEEDS_MAPPING wizard.

---

## 14. Infra changes (owner-gated, D-4)
> **Status 2026-11-16 — STAGING + PROD DONE.** Prod (verified 2026-11-13): secret `SALES_IMPORT_DRAIN_SECRET` (in the
> prod deploy preflight), job `gifsy-sales-import` deployed by `deploy.yml` after the migrate step, API env
> `SALES_IMPORT_RUNNER=job` / `SALES_IMPORT_JOB=gifsy-sales-import`, `run.jobsExecutor` for `gifsy-api-sa`, Scheduler
> `sales-import-drain` (`*/10`, ENABLED). API memory is 1 GiB on prod + staging since `e242b1a1` (the 512Mi figures in
> §3 are historical). The 2026-11-11 status below is historical.
>
> _(Historical)_ **Status 2026-11-11 — STAGING DONE, PROD PENDING the owner.** Staging (owner-approved 2026-11-10/11): secret
> `SALES_IMPORT_DRAIN_SECRET_STAGING`; Cloud Run Job `gifsy-sales-import-staging` (args `--max-old-space-size=1700
> dist/sales-import/worker.main.js`, 2Gi, 1 CPU, 3600 s, 1 retry; deployed by `deploy-staging.yml`, serves `staging-7c85d9fd`);
> `roles/run.jobsExecutor` for `gifsy-api-sa` on that job (no overrides needed); Cloud Scheduler `sales-import-drain-staging`
> (`*/10` Asia/Kolkata, `--attempt-deadline=170s`, header `x-drain-secret`) — verified 200 from the Scheduler, 403 without the
> secret. `roles/secretmanager.viewer` granted to `gifsy-deployer` for the staging preflight (redundant; over-privilege review open).
> **Prod:** none of it exists and `deploy.yml` has no worker step — job + API env + `SALES_IMPORT_DRAIN_SECRET` (+ prod preflight) +
> `run.jobsExecutor` + Scheduler need a separate owner OK at release. Until then `salesImport` can't be switched ON in prod.
- `deploy-staging.yml` (after the migrate step `:98-109`) and later `deploy.yml`:
  `gcloud run jobs deploy gifsy-sales-import-staging --image=…api:staging-${sha} --region … --command=node
  --args=--max-old-space-size=1700,dist/sales-import/worker.main.js --memory=2Gi --cpu=1 --task-timeout=3600 --max-retries=1 --tasks=1
  --set-secrets=DATABASE_URL=DATABASE_URL_STAGING:latest,GCS_BUCKET=… --set-env-vars=NODE_ENV=production
  --network=gifsy-vpc --subnet=gifsy-subnet-asia-south1 --vpc-egress=private-ranges-only --set-cloudsql-instances=…
  --service-account=gifsy-api-sa@…` (no `--execute-now`).
- API service env: `SALES_IMPORT_RUNNER=job,SALES_IMPORT_JOB=gifsy-sales-import-staging,GCP_PROJECT=${PROJECT_ID}` (+ secret
  `SALES_IMPORT_DRAIN_SECRET` if the Scheduler fallback is wanted).
- `terraform/iam.tf`: `google_cloud_run_v2_job_iam_member` for `gifsy-api-sa` on the job: `roles/run.jobsExecutor` if the runner
  calls `jobs:run` with NO overrides (the plan's design), or `roles/run.jobsExecutorWithOverrides` if it passes overrides (e.g. an
  `IMPORT_ID` env). See §10a.5 (verified on staging 2026-11-11 with `roles/run.jobsExecutor`).
- Job env: `NODE_OPTIONS=--max-old-space-size=1700` (2 GiB job; real-DB finding 1 — see §7.1 step 11. The earlier 1536 left the
  real file only ~8 % headroom under the heap backstop).
  Memory budget at that setting (§7.1 step 11): old space 1,700 MB → V8 heap_size_limit ≈ 1,892 MB on node:24; heap
  backstop trips at 1,275 MiB of used heap; shared-strings cap 400 MiB; real file peak ≈ 1.06 GB heap / 1.32 GB RSS.
- **REQUIRED (audit fix round M3/S5; also retries GCS deletions of purged imports):** Cloud Scheduler hitting `POST /v1/sales-import/drain` every 10 min with header
  `x-drain-secret` (+ secret `SALES_IMPORT_DRAIN_SECRET` on the API service). It recovers an import whose worker died
  (heartbeat-stale PROCESSING is reclaimed on the next kick) and, when nothing is queued, drives the retention sweep.
- **Scheduler attempt deadline:** create that job with an explicit `--attempt-deadline=170s` (gcloud scheduler jobs create
  http … --attempt-deadline=170s). The idle drain bounds the retention sweep by one request deadline of start + 150 s
  (§10c), so it finishes inside it.
- **Migration ordering (L3):** `20261111120000_sales_import_hardening` (and every sales-import migration) must be applied
  BEFORE the new API revision serves. Verified in the workflows: `deploy-staging.yml` and `deploy.yml` both run the
  `gifsy-migrate[-staging]` Cloud Run job with `--execute-now --wait` in the SAME job, BEFORE the `gcloud run deploy`
  step, so a failed migration fails the job and the API is not deployed. The worker job (`gifsy-sales-import[-staging]`)
  deploy step (in `deploy-staging.yml`, live on develop since 2026-11-11; the prod `deploy.yml` step is still owner-gated) must also come AFTER the migrate step.
- GCS: parts + unmatched under `sales-imports/<clientId>/<importId>/`. The API deletes parts 30 days after READY (7 days
  with `SALES_RETENTION_V2=on`; lazy, on list / drains) or immediately on DELETE. Bucket lifecycle is unchanged.
- **Retention (current — §10b is the reference):** with `SALES_RETENTION_V2` unset/OFF (the default; every env today):
  per-import data (raw parts, per-run unmatched.csv, aggregates, sample rows) 30 days after the import finishes;
  abandoned uploads after 24 h; the month history (`sales_month_histories`, §10b, + its `sales_month_history_combos`
  summary, §10c) 10 years. With `SALES_RETENTION_V2=on`: 7 days and the current month + 3 previous. Day-level data
  (`outlet_sales_days` / `sales_day_sets`) always the current month + 3 previous.
- **New API env (sales-day-level):** `SALES_RETENTION_V2` (exactly `on` enables the new windows; set it on `gifsy-api`
  AND the worker job, after §17b), `SALES_HISTORY_RETENTION_MONTHS` (optional, 1..120, default 4; V2 only),
  `SALES_DAY_BUILD_MAX_ROWS` (optional, default 500,000 matched rows: above it apply / recalculate skip the month's day
  data with a loud reason instead of risking the 1 GiB API's memory).

---

## 15. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | **Data volume / perf**: 200 MB xlsx parse time and memory; 400k aggregate rows | Streaming exceljs in a 2Gi job (spike 0-5a gates it); BigInt accumulators; `createMany` 5k chunks; keyset-paged preview; bulk `unnest` upsert. CSV path as fallback |
| R-2 | **Partial-month wipe**: a file starting on the 5th rewrites the whole month | `STARTS_AFTER_FIRST`/`ENDS_BEFORE_MONTH_END` warnings + per-month explicit ack; preview shows the delta vs current; `SalesImportApply` keeps before/after totals for forensics |
| R-3 | **Closed-month safety**: data rewritten after points were computed/approved | Apply re-checks OPEN inside the locked tx; close/apply share an advisory lock; only GIFSY reopens (audited); D-1 guard blocks export/commit for OPEN months |
| R-4 | **Duplicate/old files**: the same file twice, or an older file over a newer apply | sha256 duplicate banner; apply is a full rewrite, so re-applying is idempotent; `OLDER_THAN_LAST_APPLIED` needs an ack |
| R-5 | **Source collision**: manual upload overwriting importer KPIs (its upsert REPLACES `kpiValues`, `targets.service.ts:817-818`) | §7.4 ownership (merge + skip + delete-strip), K-7 tests |
| R-6 | Outlet-code format drift (numeric cells, leading zeros, spaces) → low match % | `normalizeOutletCode`; the preview's matched-outlet % vs the expected ~77% is the check. If off, add a mapping option (`stripLeadingZeros`) as a follow-up, raised to the owner, not silently |
| R-7 | Roster changed between processing and apply | `rosterHash` check blocks apply → Reprocess |
| R-8 | KPI definitions edited between preview and apply | `expectedDefinitionsHash` → 409 + refetch |
| R-9 | Job never starts (IAM/env missing) | Runner returns 'none' and logs; the import stays QUEUED, visible in the UI as "Queued > 2 min: contact Gifsy"; drain endpoint; P4 checks it |
| R-10 | Unlisted dependency boot crash | I-0 `require.resolve` in the runner stage of the Dockerfile |
| R-11 | Float drift in ₹/cases sums | BigInt paise/micro; conversion to number happens once at write time |
| R-12 | Staging + prod share a DB instance | All writes go through the app (tenant-scoped); no manual SQL. Any data fix needs the owner per CLAUDE.md guardrails |
| R-13 | Months older than "previous" are implicitly CLOSED, so a back-dated file for 3 months ago can't be applied without GIFSY reopen | Intended (owner rule); the preview shows the blocked reason |

---

## 16. Out of scope
- Per-transaction (bill-to-bill) points, and any change to the engine's evaluation (it stays PERIOD_AGGREGATE).
- Crediting points or payouts from the importer (the engine and credits rail own that).
- Wide/pivot files, multi-sheet merges, subtotal rows (G5). Use the manual achievement upload.
- Targets import from the DMS file (targets stay on the manual target upload).
- Auto-fetching files from the DMS (SFTP/API).
- Outlet-code crosswalks / fuzzy matching (exact code match only).
- Direct-to-GCS browser upload (D-2 B) and Cloud Scheduler wiring unless needed.
- New RBAC permission keys (D-5 A).

## 17. Open questions (to the owner)
_(Status 2026-11-16: prod infra created and verified 2026-11-13; Bajaj prod KPI config done and November 2026 applied
2026-11-15. Q5 (KPI codes) is settled by the prod KPI configuration; Q4 (points per case / cap) belongs to the pending
November points-rule session — see `RESUME.md` §4.)_
_(Status 2026-11-11: Q1–Q3 DECIDED — D-1 = A, D-3 = A, D-4 = A; staging infra approved + CREATED 2026-11-10/11, prod infra = separate OK at release.
Q7 decided = 30 days for per-import data (§14) — revised 2026-11-18: 7 days + 4-month history, behind `SALES_RETENTION_V2` (§17b). Q4–Q5 still open and now BLOCKING the staging apply of the real import `6b681de7…`: the
owner supplies points per case, monthly cap, KPI list and focus sets (BSC wholesalers only).)_

1. ~~D-1: approve the 4-decorator engine guard (A), or no engine edit (B)?~~ Decided: A.
2. ~~D-3: approve adding `exceljs` (or go CSV-only)?~~ Decided: A.
3. ~~D-4: approve the Cloud Run job + IAM binding + deploy-workflow step?~~ Decided: A (staging approved; prod at release).
4. D-8: BSC points per whole case, monthly cap, and is it WHOLESALER-only?
5. D-9: final KPI codes/labels/units for Bajaj (`ADHO TARGET`, `NON ADHO`, `CNO 500` ₹ and cases, `BSC CASES`); should `MONTH TARGET`
   become importer-owned (it is currently manually backfilled)?
6. Should closing a month also be blocked while an apply/import for it is in flight? (Plan: close takes the same lock, so they serialize. No extra block.)
7. ~~Retention for raw uploaded files (plan: 30 days after READY).~~ Decided 2026-11-18: 7 days for per-import data and
   the current month + 3 previous for month history, history = programme outlets only. The windows take effect only with
   `SALES_RETENTION_V2=on`, after the runbook below (until then: 30 days / 10 years, as before).

## 17b. Runbook — moving existing data to the new retention (sales-day-level; owner-gated, in THIS order)

Deploying the release changes NO retention (switch `SALES_RETENTION_V2` default OFF). Per environment (staging first,
then prod), each step only after the previous one is verified, and each `--apply` only with the owner's explicit OK.
Commands run as a Cloud Run job execution of the API image inside the VPC (the migrate-job recipe), with
`TRIM_TARGET_DB` = the exact database name (the script refuses otherwise):

1. **Backup** the database (Cloud SQL on-demand backup) and record its id. No backup → stop.
2. **rebuild-days**, for EACH month inside the new window (current month + 3 previous) that has history but no day data
   (the trim dry-run's step "0)" lists them): `rebuild-days --client <id> --month YYYY-MM` (dry-run) → review (it refuses
   — and says why — when the stored file is gone, does not reproduce the stored lines, or the current definitions no
   longer give the stored figures) → the same with `--apply`. Run with `--max-old-space-size=1700` in the 2 GiB job.
   Months whose file is already gone cannot be rebuilt: re-apply their file, or accept no day data for them.
3. **trim**: `trim` (dry-run) → review the counts per tenant × month (0: months still without day data; 1: history rows of
   customers NOT on today's roster + outlet ids to back-fill + any SKIPPED tenant (empty roster); 2: months older than
   the window; 3: imports older than 7 days) → `trim --apply`. It REFUSES while step 0 lists a month (its file would be
   purged, the only source for rebuild-days): go back to step 2 for it, or pass `--allow-no-day-data` only if the owner
   accepts losing that month's day data for good. Re-run the dry-run afterwards: every count should be 0.
4. **Switch on**: set `SALES_RETENTION_V2=on` on `gifsy-api` AND the sales-import worker job (same value; redeploy /
   update the env). From then on the sweeps keep 7 days / current month + 3 previous by themselves.

Rollback: unset the switch (the sweeps return to 30 days / 10 years; already-deleted data does not come back — restore
from the step-1 backup if needed).

---

## 18. Traps learned on the prod November 2026 apply (2026-11-15) — read before configuring or uploading

1. **Focus product names come from the target file's SECOND column with the same heading.** When a KPI has a per-outlet
   name override whose label equals the KPI's own label (Bajaj FOCUS BRAND / FOCUS BRAND 2), the target-upload parser
   (`api/src/targets/targets.helpers.ts`, `parseTargetUploadBuffer`) takes the **first** column with that heading as
   the target VALUE and the **second** as the per-outlet NAMES, stored in `OutletTarget.targetValues.__names[kpiCode]`.
   A KPI with `productSource: 'TARGET_NAMES'` (FOCUS-FROM-TARGETS) reads its products only from there. If the second
   column is missing, renamed or moved outside the month block, that month has no focus names → the month preview's
   reconciliation shows the gap/blocker. Check the preview before apply; never assume the names arrived.
2. **The Sales Import KPI scope is INTERSECTED with the target KPI's applies-to scope** (Targets → KPIs: outlet types /
   programs / sub-programs). `sales-kpi.helper.ts` `intersectAppliesTo(definition scope, KpiDef scope)`: a sales-import
   definition scoped wider than its target KPI still writes only the target KPI's outlets; a disjoint pair writes no
   outlet. When a value is "missing" for an outlet, check both scopes first.
3. Result of the November apply: 6,452 outlet records written and verified per outlet; month left OPEN for the points
   rule (SAMT gate on NON ADHO ≥ ₹200 Elite / ≥ ₹400 Privilege, plus the rest of the rule — dedicated session pending).
4. **Apply cut off at 30 s → false "Nothing was applied: ." → repeat applies (prod, 2026-11-17/18).** The Next `/api/*`
   rewrite proxy had a 30 s default limit; the Bajaj apply takes ~30+ s, so the browser got a bare 500 while the backend
   FINISHED (prod DB: 4 applies from 4 clicks on 2026-11-18, 3 the day before). Fixed on branch
   `fix/proxy-timeout-honest-apply`: `experimental.proxyTimeout = 300_000` in `platform/next.config.ts` (= Cloud Run's
   300 s) AND item 5 below (Apply / Recalculate no longer run inside the request at all). Every sales-import action that
   gets no clear answer (network / 408 / 5xx / cut-off 2xx — `platform/src/lib/request-outcome.ts`) says so plainly
   instead of "nothing happened"; "didn't reply in time" is used only for real timeouts (408 / 504 / 524).
5. **Apply and Recalculate are BACKGROUND JOBS (owner decision 2026-11-18, platform-wide approved).** Files reach
   300–350 MB at month end; one month took 21 → 36 s in four days and may reach 60–90 s; the Cloudflare Worker cuts
   tenant-host requests at ~100 s, and the API runs CPU-throttled once a response is sent.
   - **Tables** (migration `20261118170000_sales_apply_jobs`, additive): `sales_apply_jobs` (one per click: kind
     APPLY / RECALC, the validated request, who, `requestId`, status QUEUED → RUNNING → DONE / FAILED, claim token +
     heartbeat + attempts) and `sales_apply_job_months` (one per month: status + the ApplyMonthResult). A PARTIAL unique
     index allows ONE active (QUEUED / RUNNING) job per tenant × month.
   - **API**: `POST admin/sales-import/:id/apply` and `POST admin/sales-months/:month/recalculate` run every cheap check
     (all the 4xx as before, except the focus-fingerprint check, which the worker runs before any write), record the job
     and answer **202 `{ job, results }`** (`results` = one "being applied in the background — refresh" line per month for a
     page loaded before the release). A second Apply / Recalculate of a month with an active job → **409** "<Month> is
     being applied by X since 10:32…". **Close / Reopen → 409** "<Month> is being applied by X since 10:32 — try again
     when it finishes." `GET admin/sales-import/apply-jobs/:jobId` = progress; `GET …/apply-jobs?requestId=` = the job a
     click created (404 = nothing recorded). The preview's months and the Months list carry `activeJob`.
   - **Worker**: the existing Cloud Run Job `gifsy-sales-import[-staging]` (1 CPU, 2 GiB, 3600 s; same image as the API,
     updated by every deploy; the API SA holds `roles/run.jobsExecutor` on it — checked read-only 2026-11-18, no IAM
     change). The POST kicks it (`jobs:run`, ~3 s to schedule + boot); the 10-minute Cloud Scheduler drain also kicks it
     when a job is waiting or stale. It drains apply jobs FIRST, then imports, then jobs again. Each month is ONE
     transaction (≤ 300 s) and its month row is set DONE INSIDE that transaction (guarded by the claim token): a crash rolls
     both back, a reclaimed job (heartbeat > 10 min) re-runs only months not yet written — never twice. After 3 claims the
     remaining months are FAILED with a reason.
   - **Page**: Apply / Recalculate send a per-click `requestId`; the page shows Queued → Applying <Month> (started HH:MM)
     → the result card per month, polling every 2 s; it is refresh-safe and shows another admin's job ("Started by X");
     Apply / Recalculate are disabled (with the reason read out) while a job runs. With no clear answer the click is
     looked up by `requestId`: found → follow it; 404 → "Nothing was applied: …, and nothing was recorded" + Try again
     (resends the SAME requestId — harmless); lookup fails too → "We couldn't confirm whether this apply was recorded…
     Don't apply again yet" + Check again, Apply disabled. Still queued after 2 min → says the processor will be started
     again within 10 minutes.
   - **Dual audit of `e1ce98d8` fixed** (exactly-once held; no critical): a retried job resolves focus names against the
     product lists its FIRST run snapshotted (`sales_apply_jobs.focusBasis`), so months a run already wrote cannot make
     later ones "focus products changed" (A-M1); SIGTERM hands the job back at once (QUEUED, no heartbeat) instead of
     leaving it stuck 10–20 min (A-M2); every reset / release is guarded by the claim token (A-M3); a CLOSED / not
     started month is refused at enqueue (409, A-L1); a transient DB error (connection, deadlock / serialization, Prisma
     P1001 / P2024 / P2028 / P2034 …) hands the job back for a retry instead of failing the month (A-L2); stops and lost
     claims do not use up attempts, and "Stopped after 3 attempts: <last error>" keeps the month's `lastError` (A-L3);
     the worker re-checks the tenant flag and that the requester is still ACTIVE and allowed (targets:upload) before
     each job (A-L4); a requestId reused for a different import / kind / months → 409 (A-L5); Reprocess / Read again /
     Cancel / Delete of an import with an active job → 409 and disabled in the UI (A-L6 / B-M8). A drain never re-claims
     a job it handed back in the same run (back-off until the next kick or the 10-minute drain). Each month's latest
     FINISHED job is on the preview and the Months list (`lastJob`), so a result never disappears (B-H1). The Recalculate
     202 also carries a top-level not-ok result for an old Months tab (B-H2).
   - **Deploy order (A-M4 / B-M3)**: both workflows deploy the API BEFORE the frontend (`deploy.yml`:
     `deploy-frontend` needs `deploy-api`; `deploy-staging.yml`: `deploy-frontend-staging` needs `deploy-api-staging`), so
     the skew window is "new API + old page" (handled by the old-shape `results` / top-level result). Never deploy the
     frontend alone ahead of this API: a new page against an old API would get a plain 404 from the requestId lookup —
     the page treats any 404 WITHOUT the server's own "No apply was recorded for this request." text as UNKNOWN (Apply
     held + Check again), never as "nothing recorded", and says "nothing recorded" only after a second lookup ~5 s later.
   - **Migration notes — keep the partial index.** `sales_apply_job_months_active_month_key` (one active job per
     tenant × month) exists only in migration `20261118170000_sales_apply_jobs`; Prisma cannot express it, so any later
     `prisma migrate dev` WILL generate `DROP INDEX "sales_apply_job_months_active_month_key"` — delete that line from the
     generated migration. `api/src/sales-import/apply/active-month-index.spec.ts` fails if a later migration drops it
     without re-creating it.
   - **Re-review of `91e4cc46` fixed**: a month whose write runs past the 300 s transaction timeout is FINAL ("<Month>
     took longer than 5 minutes to write and was rolled back — nothing changed…", logged loudly) — only connection-level
     errors and "Unable to start a transaction" are retried (M1); the worker keeps ONE hand-back list for its whole run
     (M2); polling reads select explicit columns, never `focusBasis` (M3); a lost claim inside the write is a stop, and
     a hand-back is one statement (L1) that is awaited after SIGTERM (L2); a whole-job refusal after a partial success
     names the months already applied and those not run (L3); Gifsy staff also need their per-tenant grant (L4).
   - **Final review of `f616a390` fixed**: a LOST transaction (Prisma P2028 "Transaction not found … obtained before
     disconnecting" — connection drop / engine restart) is retried, never reported as "file too large"; only an EXPIRED
     transaction ("Transaction already closed: … expired transaction … timeout for this transaction") is final (M1). A
     stop hand-back is awaited even when the run then finishes, and its failure is logged, never thrown (L1). Close /
     Reopen check for an active job UNDER the month lock, in the transaction that changes the state (L4). After a final
     401 / 403 / 404 while following, the Recalculate panel says the job may still be running and keeps Recalculate held
     until a Months-list read made after that shows no active job (L5).
   - **Worker DB connections (L2)**: the `gifsy-sales-import` job uses the SAME `DATABASE_URL` secret as the API
     (`deploy.yml` / `deploy-staging.yml` set no extra query parameters; any `connection_limit` lives inside the secret,
     which was NOT read for this note). Prisma's default pool is `num_cpus × 2 + 1` = **3** on the job's 1 CPU. A month
     write holds ONE connection for up to 300 s, so the SIGTERM hand-back (started at once from the signal, before the
     month is aborted) gets its own pooled connection. ⚠️ If the secret ever sets `connection_limit=1`, the hand-back
     waits behind the month's transaction and the job is only recovered by the 10-minute stale-heartbeat reclaim — keep
     the worker's pool at ≥ 2 (check before changing the secret).
   - **RBAC parity (L3)**: the worker's `targets:upload` re-check reads `RBAC_ENFORCEMENT` from its own env, which the job
     does not set — exactly like the API service today (neither workflow sets it). If it is ever turned on for the API,
     set it on the `gifsy-sales-import` job too.
   - **Import actions vs a running job (L4)**: Reprocess / Read again / Cancel / Delete check for an active job of the
     import BEFORE taking the import's row lock. The race left open is covered loudly by the worker: each month write holds
     the import row `FOR SHARE` (Reprocess / Cancel / Delete need `FOR UPDATE NOWAIT` → 409 while a month is writing), and
     a job whose import was reprocessed / cancelled / deleted between months fails WHOLE with the server's reason ("This
     file was reprocessed after the preview…" / "not READY"), shown on every month — never silently.
   - **Rollback runbook** (only if the release is rolled back to code without jobs): the old code ignores the new tables,
     but a QUEUED / RUNNING job would never run. Before deploying the old image, run on the target DB (with the usual
     `current_database()` guard, backup confirmed, SQL shown to the owner first):
     `UPDATE "sales_apply_job_months" SET "status" = 'FAILED', "result" = jsonb_build_object('month', "month", 'ok', false,
     'error', 'Stopped by a rollback. Nothing was written for this month - apply it again.'), "finishedAt" = (now() AT TIME
     ZONE 'UTC') WHERE "status" IN ('QUEUED','RUNNING');` then
     `UPDATE "sales_apply_jobs" SET "status" = 'DONE', "claimToken" = NULL, "finishedAt" = (now() AT TIME ZONE 'UTC')
     WHERE "status" IN ('QUEUED','RUNNING');` and tell admins to apply those months again. Nothing is half-written (each
     month is one transaction). The tables can stay (additive).
   - **Tests**: `api/src/sales-import/apply/sales-apply-jobs.service.spec.ts` (enqueue, 409, resend, worker run, reclaim,
     stop, attempts cap, lost claim, controllers 202 + kick), `sales-apply.service.spec.ts` (hooks + prechecks + preview
     `activeJob`), `months/sales-months.spec.ts` (Close / Reopen 409, `activeJob`), `api/test/sales-apply-jobs.e2e-spec.ts`
     (REAL Postgres, opt-in `SALES_IMPORT_E2E=1`: partial index, SKIP LOCKED, DONE rolls back with the write);
     platform `import-detail.test.tsx` / `months-and-gate.test.tsx`.
---

## Appendix A — Bajaj configuration (DATA entered via the Settings screen on staging; never in code)
```json
{
  "sheetName": null,
  "headerRow": "auto",
  "outletCode": "CUSTOMER CODE",
  "outletName": "CUSTOMER",
  "invoiceDate": "INVOICE DATE",
  "amount": "NET AMT",
  "quantity": "QTY (CASES)",
  "dimensions": [ { "key": "brand", "label": "Brand", "header": "CODE" },
                  { "key": "skuGroup", "label": "SKU group", "header": "CLUB SKU" } ],
  "dateOrder": "DMY"
}
```
| kpiCode (must be a KpiDef) | measure | filter | scope |
|---|---|---|---|
| MONTH TARGET | AMOUNT | `{}` | all |
| ADHO TARGET | AMOUNT | `{"anyOf":[{"brand":"ADHO"}]}` | all |
| NON ADHO | AMOUNT | `{"noneOf":[{"brand":"ADHO"}]}` | all |
| CNO 500 | AMOUNT | `{"anyOf":[{"brand":"CNO","skuGroup":"500"}]}` | all |
| CNO 500 CASES | QUANTITY | `{"anyOf":[{"brand":"CNO","skuGroup":"500"}]}` | all |
| BSC CASES | QUANTITY | `{}` | outletTypes `["WHOLESALER"]` |
| FOCUS ADHO SET (example multi-combo) | AMOUNT | `{"anyOf":[{"brand":"ADHO","skuGroup":"500"},{"brand":"ADHO","skuGroup":"200"},{"brand":"ADHO","skuGroup":"150"}]}` | all |
| FOCUS ADHO SET CASES | QUANTITY | same filter as above | all |

(Brand spellings like `CNO Enrich`, `Banjara's`, `Sarson Amla` normalize to uppercase with collapsed spaces. `CNO` ≠ `CNO ENRICH`. Use
the Settings "Test against latest import" button and the `dimensionValues` list to confirm exact values.)

---

## Walkthrough for the owner (plain English, non-technical)

This is how a month looks for a client like Bajaj once Sales Import is switched on. "Admin" means a Gifsy admin working inside
the client, or the client's own admin.

### 1. One-time setup (done once, changed rarely)
1. **Gifsy switches the feature on** for the client in the Gifsy console ("Sales Import"). Nobody else sees anything until then.
2. **Tell the portal how to read the client's file.** The admin uploads one real sales file. If the portal doesn't recognise the
   columns, it shows the column headings it found. The admin picks which column is the customer code, the invoice date, the
   amount, the cases quantity, and which columns describe the product (for Bajaj: brand and SKU size). This is saved and reused
   every time.
3. **Define the KPIs** (the numbers each outlet is measured on). For each one the admin chooses:
   - **what to count:** rupees or cases;
   - **which products:** everything; one brand; everything except a brand; or a **focus set**, any mix of brand + size picked
     from a list of what actually appears in the file (e.g. "ADHO 500 + ADHO 200 + ADHO 150"), whole brands ("all CNO"), and
     exclusions ("except CNO 50"). A product is counted once even if it fits two entries. The screen warns if a picked product
     never appears in the latest file, which usually means a typo or a size that isn't sold yet;
   - optionally, **which outlets** it applies to (e.g. only wholesalers).
   A "Test" button shows the monthly totals straight away, so the admin can check against the client's own numbers.
   From then on, these KPIs come **only** from the sales file. If someone tries to upload them in the old manual achievement
   sheet, the portal skips those columns and says why. Other KPIs can still come from the manual sheet.
4. **Targets (in rupees) are uploaded exactly as today**, using the existing target upload.
5. **The points rule for wholesalers (BSC)** is set up once in the existing Points Engine: "if the outlet reached at least 100%
   of its rupee target, give N points per whole case, up to a monthly cap". It is tested in the built-in simulator before it is
   switched on.

### 2. During the month
1. Whenever the client sends a fresh sales file (daily, weekly, or whenever), the admin uploads it. Big files (hundreds of MB)
   are fine. The screen shows upload and processing progress, and the admin can leave and come back.
2. The portal shows a **preview for each month in the file**: dates covered, number of invoice lines, how many of our outlets
   were found, how many customers in the file are not in the programme (ignored), rupee and case totals, and how each KPI would
   change compared with what's stored now. It warns if a month looks partial (for example, the file starts on the 5th).
3. The admin **ticks the months to update** and presses Apply. Each ticked month is replaced completely by what's in the file.
   Outlets with no sales in the file get zero for that month. Months not ticked are left alone. Only the current month and the
   previous month (until it's closed) can be ticked.
4. **What partners and the sales team see:** their target cards, "My Targets" and the sales dashboards show the updated
   achievement right after Apply, as they do today after a manual upload. **No points move during the month.**

### 3. Month end
1. Early in the new month, the admin uploads the **final file for the previous month**, checks the preview, and applies it.
2. The admin presses **"Close <month>"**. That month is now locked: no more file updates can change it.
3. In the Points Engine, the admin **computes points for the closed month**, reviews the preview, and downloads the report for
   the client. (If the owner approves the safeguard, the portal refuses to produce this report for a month that is still open.)
4. **The client approves the report offline**, as today.
5. A Gifsy operator **confirms the credit** through the existing credits screen. Points then reach wallets exactly as they do
   now, with the same checks and the same ability to reverse.

### 4. Corrections
- **Before the month is closed:** upload a corrected file and apply that month again. It simply replaces the month's numbers.
  Uploading the same file twice is harmless, and the portal says it's a repeat.
- **After the month is closed:** only Gifsy can reopen it. Reopen, apply the corrected file, close again, and recompute. If
  points were already credited, the difference goes through the existing reversal process. Every apply, close and reopen is
  recorded with who did it and when.

### 5. What changes and what stays the same
- **For Bajaj (once switched on):** no more hand-building achievement sheets from the DMS export. Upload the raw file and the
  portal works out the monthly KPIs, including multi-product focus sets, rupees and cases. Months are formally closed before
  points are computed. Points are still approved by the client and confirmed by Gifsy as today. The importer never credits
  points by itself.
- **For every other client, including Deoleo:** nothing changes. The feature is off; the manual target and achievement uploads,
  the credits upload, wallets and the Points Engine work exactly as they do today. Any client can be switched on later, with its
  own file layout and its own KPIs, and no new code.
- **Limit:** the file must have one row per invoice line (like the DMS export). Summary or pivot-style sheets keep using the
  manual achievement upload.
