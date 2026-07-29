# Visibility-Led Payouts / 194C Invoicing + Configurable TDS — WAVE 0 (schema + migration + frozen contracts)

**Status:** Wave 0 draft — awaiting owner sign-off on the migration SQL BEFORE any DB touch (incl. `gifsy_dev`).
Parent spec + decisions D1–D14: `VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md`. Money path → dual adversarial
audit mandatory (Wave 3). This doc is the frozen contract the Wave 1/2 streams build against.

## 0. Decisions locked in Wave 0 (owner-confirmed this session, on top of D1–D14)

- **W0-A — Config store = JSON, hardened (not a typed table).** Per-tenant `{section, methodology}` lives as a
  strict `tdsPolicy` key in `TenantSettingsService` (the existing `program_settings` overlay — same store as
  `conversionRate`, `visibilityConfig`). **Fail-closed is SCOPED to the money path** (blast-radius fix during
  W0.5): the payout engine reads `resolveTdsPolicy(clientId)` — an **uncached strict read** that **rejects a
  malformed value** (throws) and defaults only a genuinely **absent** key → `{SEC_194C, GROSS_UP}`. The broad,
  cached `getEffectiveSettings()` stays **tolerant** (a malformed `tdsPolicy` degrades to default there, logged)
  so one bad TDS value can never break `conversionRate`/channels/visibility for the tenant. Rationale: the
  near-identical selector
  `visibilityCaptureMode` already lives in JSON; a singleton typed policy table would be a brand-new pattern; and
  the freeze (W0-B) makes the live store non-authoritative anyway. Confirmed against industry best practice
  (Stripe immutable/effective-dated tax rates; Fowler Effectivity+Snapshot+Audit-Log).
- **W0-B — Freeze-on-confirm (the spine).** At payout-Excel **confirm**, the RESOLVED `section` + `methodology`
  are **stamped by value** onto each `CreditPayoutEntry` (`tdsSection`, `tdsMethodology`). Compute reads the
  frozen stamp, never a live config lookup — a later config edit can't retroactively change a payout's treatment.
  Mirrors the existing `conversionRateCenti` rate-freeze. **Never store a FK to the config row** (that re-opens the
  mutation bug).
- **W0-C — Config-change audit log.** Every `tdsPolicy` write appends an `AuditLog` row
  (`action=UPDATE, entityType='TdsPolicy', entityId=clientId, oldValues/newValues`). Reuses the existing
  `audit_logs` table + `AuditAction.UPDATE` → **zero schema change**.
- **W0-D — Gross-up TDS invoice = one per (clientId, PAN, FY)** (literal D9; owner-chosen). Stored on `AutoInvoice`
  with `invoiceKind='TDS'`; a partial unique `WHERE invoiceKind='TDS'` enforces one-per-PAN/FY. Pro-rata tenant
  recovery is a **separate internal ledger** (`tds_recovery_entries`), dashboard-only, never on the invoice face.
- **W0-E — Rollout = DEFAULT-ON** (owner-chosen). No config row → the engine applies defaults `{194C, GROSS_UP}`
  at confirm. ⚠️ Concrete effect to keep in view: once shipped, a tenant that actually runs visibility (separate-
  payout) credit batches — e.g. Deoleo, *if* it has such fields with flowing payouts — begins generating
  at-threshold TDS invoices + recovery + GST-holdback at the 194C/gross-up defaults on its next confirm. (If we'd
  rather it stay dormant until Gifsy sets each tenant's policy, that's a one-line change to the resolver default —
  flagged for the owner.)
- **W0-F — `payoutStream` replaces `isSeparatePayout` as the classifier**, added + backfilled now;
  `isSeparatePayout` kept as a deprecated mirror through the build and **dropped in Wave 3** after all 4 read-sites
  are repointed + audited (safest sequencing for a money path).
- **W0-G — Typed rigor goes to the LEDGERS, not the config.** `tds_deduction_entries` (carry-forward) and
  `tds_recovery_entries` (recovery) are typed, append-only tables — that is where reproducibility/audit lives.

## 1. New enums

```prisma
enum PayoutStream   { VISIBILITY  INCENTIVE }          // classifier on CreditField (replaces isSeparatePayout)
enum TdsMethodology  { DEDUCT      GROSS_UP  }          // per-tenant + frozen on each payout entry
enum AutoInvoiceKind { SERVICE     TDS       }          // AutoInvoice discriminator (default SERVICE)
enum GstReimbursementStatus { HELD RELEASED }
// reuse existing: TdsSection { SEC_194R SEC_194C }, AuditAction.UPDATE
```

## 2. Changed models

```prisma
model CreditField {
  // ...existing...
  isSeparatePayout Boolean      @default(false)   // DEPRECATED mirror — drop in W3 after read-sites repointed
  payoutStream     PayoutStream @default(INCENTIVE) // NEW — the classifier (backfilled from isSeparatePayout)
}

model CreditPayoutEntry {
  // ...existing...
  autoInvoiceId  String?         // NEW — link to the SERVICE AutoInvoice (set at confirm); lock-at-UTR target
  tdsSection     TdsSection?     // NEW — FROZEN at confirm (W0-B); null = legacy / not-applicable
  tdsMethodology TdsMethodology? // NEW — FROZEN at confirm (W0-B)
  tdsDeductedPaise BigInt @default(0) // NEW — DEDUCT-method net withheld at download; 0 for gross-up/incentive
  autoInvoice    AutoInvoice? @relation(fields: [autoInvoiceId], references: [id], onDelete: SetNull)
  @@index([autoInvoiceId])
}

model AutoInvoice {
  // ...existing...
  invoiceKind     AutoInvoiceKind @default(SERVICE) // NEW
  lockedAt        DateTime?                          // NEW — lock at UTR entry (decoupled from the manual PAID)
  linkedPanNumber String?                            // NEW — TDS invoices: the retailer PAN
  linkedFyLabel   String?                            // NEW — TDS invoices: the FY (e.g. "2026-27")
  creditEntries   CreditPayoutEntry[]                // NEW back-relation
  reimbursement   GstReimbursement?                  // NEW back-relation
  // unique changes: [clientId, outletCode, period] -> [clientId, outletCode, period, invoiceKind]
  // + migration-only PARTIAL unique (clientId, linkedPanNumber, linkedFyLabel) WHERE invoiceKind='TDS'
}
```

## 3. New models (typed, append-only ledgers + GST holdback)

```prisma
/// DEDUCT-method carry-forward ledger. Append-only. Running carry = latest row's carryForwardPaise per (pan,section,fy).
model TdsDeductionEntry {
  id                    String     @id @default(cuid())
  clientId              String
  panNumber             String
  section               TdsSection
  fyLabel               String
  creditPayoutEntryId   String?
  outletCode            String?
  eventBasePaise        BigInt     // the payout base at this event
  cumulativeBasePaise   BigInt     // PAN FY cumulative base after this event
  tdsRate               Decimal    @db.Decimal(5, 2)
  tdsDueCumulativePaise BigInt     // TDS due on the cumulative base
  tdsDeductedPriorPaise BigInt     // sum deducted before this event
  tdsDeductedThisPaise  BigInt     // deducted from THIS payout
  carryForwardPaise     BigInt     // remaining un-deducted after this event
  createdAt             DateTime   @default(now())
  @@index([panNumber, section, fyLabel])
  @@index([clientId])
  @@index([creditPayoutEntryId])
  @@map("tds_deduction_entries")
}

/// GROSS-UP pro-rata tenant recovery / attribution ledger ("in lieu of TDS"). Append-only. Dashboard-only.
model TdsRecoveryEntry {
  id               String     @id @default(cuid())
  clientId         String     // tenant recovered from
  panNumber        String
  section          TdsSection
  fyLabel          String
  tdsInvoiceId     String?    // the AutoInvoice(kind=TDS) this recovery settles
  panTdsTotalPaise BigInt     // total TDS deposited for the PAN at this event
  tenantBasePaise  BigInt     // this tenant's contribution (pro-rata numerator)
  panBasePaise     BigInt     // PAN aggregate base (denominator)
  tenantSharePaise BigInt     // pro-rata recovery amount
  createdAt        DateTime   @default(now())
  @@index([clientId, fyLabel])
  @@index([panNumber, section, fyLabel])
  @@index([tdsInvoiceId])
  @@map("tds_recovery_entries")
}

/// GST HOLDBACK: base paid now, GST held, released on the retailer's deposit proof (Gifsy-only screen).
model GstReimbursement {
  id               String                 @id @default(cuid())
  clientId         String
  autoInvoiceId    String                 @unique
  partnerId        String
  outletCode       String
  gstPaise         BigInt
  status           GstReimbursementStatus @default(HELD)
  proofUrl         String?
  releasePayoutRef String?
  releasedAt       DateTime?
  releasedById     String?
  notes            String?
  createdAt        DateTime               @default(now())
  updatedAt        DateTime               @updatedAt
  autoInvoice      AutoInvoice            @relation(fields: [autoInvoiceId], references: [id], onDelete: Cascade)
  @@index([clientId])
  @@index([status])
  @@map("gst_reimbursements")
}
```

## 4. Migration SQL (`20260728120000_visibility_payout_tds_foundation/migration.sql`)

**SHAPE: FULLY ADDITIVE** — new enums, new nullable/defaulted columns + a backfill, new tables, and one
unique-index swap on `auto_invoices` (all existing rows default `invoiceKind='SERVICE'`, so the new key holds
identically). No data is dropped → **no abort-guard needed** (unlike the destructive visibility/scheme rebuilds).

```sql
-- Visibility-led payouts: 194C auto-invoicing + tenant-configurable TDS — Wave 0 foundation.
-- See platform/docs/plans/VISIBILITY-PAYOUT-TDS-WAVE0-SCHEMA.md + VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md.
--
-- SHAPE: ADDITIVE. New enums + columns (with defaults + a payoutStream backfill) + ledger/holdback tables +
-- an auto_invoices unique-key swap (kind-aware). No rows dropped; existing invoices default invoiceKind=SERVICE
-- so the new unique holds identically. Zero-downtime; no abort-guard required.

-- CreateEnum
CREATE TYPE "PayoutStream" AS ENUM ('VISIBILITY', 'INCENTIVE');
CREATE TYPE "TdsMethodology" AS ENUM ('DEDUCT', 'GROSS_UP');
CREATE TYPE "AutoInvoiceKind" AS ENUM ('SERVICE', 'TDS');
CREATE TYPE "GstReimbursementStatus" AS ENUM ('HELD', 'RELEASED');

-- AlterTable: CreditField — add classifier, backfill from the deprecated boolean
ALTER TABLE "credit_fields" ADD COLUMN "payoutStream" "PayoutStream" NOT NULL DEFAULT 'INCENTIVE';
UPDATE "credit_fields" SET "payoutStream" = 'VISIBILITY' WHERE "isSeparatePayout" = true;

-- AlterTable: CreditPayoutEntry — invoice link + frozen TDS treatment + DEDUCT net
ALTER TABLE "credit_payout_entries"
  ADD COLUMN "autoInvoiceId" TEXT,
  ADD COLUMN "tdsSection" "TdsSection",
  ADD COLUMN "tdsMethodology" "TdsMethodology",
  ADD COLUMN "tdsDeductedPaise" BIGINT NOT NULL DEFAULT 0;

-- AlterTable: AutoInvoice — kind, UTR-lock, TDS-invoice PAN/FY link
ALTER TABLE "auto_invoices"
  ADD COLUMN "invoiceKind" "AutoInvoiceKind" NOT NULL DEFAULT 'SERVICE',
  ADD COLUMN "lockedAt" TIMESTAMP(3),
  ADD COLUMN "linkedPanNumber" TEXT,
  ADD COLUMN "linkedFyLabel" TEXT;

-- Swap the idempotency unique to be kind-aware (SERVICE rows unaffected; lets a TDS row coexist)
DROP INDEX "auto_invoices_clientId_outletCode_period_key";
CREATE UNIQUE INDEX "auto_invoices_clientId_outletCode_period_invoiceKind_key"
  ON "auto_invoices"("clientId", "outletCode", "period", "invoiceKind");
-- One gross-up TDS invoice per (clientId, PAN, FY) — partial unique (Prisma can't model; migration-only, per house convention)
CREATE UNIQUE INDEX "auto_invoices_tds_pan_fy_key"
  ON "auto_invoices"("clientId", "linkedPanNumber", "linkedFyLabel")
  WHERE "invoiceKind" = 'TDS';

-- CreateTable: tds_deduction_entries (DEDUCT carry-forward, append-only)
CREATE TABLE "tds_deduction_entries" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "panNumber" TEXT NOT NULL,
  "section" "TdsSection" NOT NULL,
  "fyLabel" TEXT NOT NULL,
  "creditPayoutEntryId" TEXT,
  "outletCode" TEXT,
  "eventBasePaise" BIGINT NOT NULL,
  "cumulativeBasePaise" BIGINT NOT NULL,
  "tdsRate" DECIMAL(5,2) NOT NULL,
  "tdsDueCumulativePaise" BIGINT NOT NULL,
  "tdsDeductedPriorPaise" BIGINT NOT NULL,
  "tdsDeductedThisPaise" BIGINT NOT NULL,
  "carryForwardPaise" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tds_deduction_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tds_deduction_entries_panNumber_section_fyLabel_idx" ON "tds_deduction_entries"("panNumber", "section", "fyLabel");
CREATE INDEX "tds_deduction_entries_clientId_idx" ON "tds_deduction_entries"("clientId");
CREATE INDEX "tds_deduction_entries_creditPayoutEntryId_idx" ON "tds_deduction_entries"("creditPayoutEntryId");

-- CreateTable: tds_recovery_entries (GROSS-UP pro-rata recovery, append-only, dashboard-only)
CREATE TABLE "tds_recovery_entries" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "panNumber" TEXT NOT NULL,
  "section" "TdsSection" NOT NULL,
  "fyLabel" TEXT NOT NULL,
  "tdsInvoiceId" TEXT,
  "panTdsTotalPaise" BIGINT NOT NULL,
  "tenantBasePaise" BIGINT NOT NULL,
  "panBasePaise" BIGINT NOT NULL,
  "tenantSharePaise" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tds_recovery_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tds_recovery_entries_clientId_fyLabel_idx" ON "tds_recovery_entries"("clientId", "fyLabel");
CREATE INDEX "tds_recovery_entries_panNumber_section_fyLabel_idx" ON "tds_recovery_entries"("panNumber", "section", "fyLabel");
CREATE INDEX "tds_recovery_entries_tdsInvoiceId_idx" ON "tds_recovery_entries"("tdsInvoiceId");

-- CreateTable: gst_reimbursements (GST holdback/release; Gifsy-only screen)
CREATE TABLE "gst_reimbursements" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "autoInvoiceId" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  "outletCode" TEXT NOT NULL,
  "gstPaise" BIGINT NOT NULL,
  "status" "GstReimbursementStatus" NOT NULL DEFAULT 'HELD',
  "proofUrl" TEXT,
  "releasePayoutRef" TEXT,
  "releasedAt" TIMESTAMP(3),
  "releasedById" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gst_reimbursements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gst_reimbursements_autoInvoiceId_key" ON "gst_reimbursements"("autoInvoiceId");
CREATE INDEX "gst_reimbursements_clientId_idx" ON "gst_reimbursements"("clientId");
CREATE INDEX "gst_reimbursements_status_idx" ON "gst_reimbursements"("status");

-- CreateIndex: CreditPayoutEntry.autoInvoiceId
CREATE INDEX "credit_payout_entries_autoInvoiceId_idx" ON "credit_payout_entries"("autoInvoiceId");

-- AddForeignKey
ALTER TABLE "credit_payout_entries" ADD CONSTRAINT "credit_payout_entries_autoInvoiceId_fkey"
  FOREIGN KEY ("autoInvoiceId") REFERENCES "auto_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "gst_reimbursements" ADD CONSTRAINT "gst_reimbursements_autoInvoiceId_fkey"
  FOREIGN KEY ("autoInvoiceId") REFERENCES "auto_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

## 5. Frozen contracts (what Wave 1/2 build against — do not change without a re-freeze)

- **Config resolver** — `TenantSettingsService.getEffectiveSettings(clientId).tdsPolicy: { section: 'SEC_194R'|'SEC_194C'; methodology: 'DEDUCT'|'GROSS_UP' }`. Overlay validates against those exact literals: absent → `{SEC_194C, GROSS_UP}` (default-on); present-but-invalid → **throw/fail-closed**, never coerce. Write path (`AdminCoreService.upsertSetting`) busts the cache + appends the `AuditLog` (W0-C).
- **Section derivation** — an entry's frozen `tdsSection` = (payoutStream=INCENTIVE → `SEC_194R`) else (payoutStream=VISIBILITY → tenant `tdsPolicy.section`). Frozen at confirm.
- **Freeze point** — `credits.service.confirmBatch` `$transaction` (after `creditPayoutEntry.createMany`, `:377-393`): resolve `tdsPolicy` once, stamp `tdsSection`/`tdsMethodology` on each entry; generate the SERVICE `AutoInvoice` per outlet (via injected `InvoicesService`, triggered here not admin-per-period) and set `autoInvoiceId`. `CreditsModule` imports `InvoicesModule`.
- **Lock point** — `credits.service.uploadUtr` `$transaction` (`:1122-1129`): on `apply`, set the linked `AutoInvoice.lockedAt=now`; edits (partner/admin invoice-number) gate on `lockedAt != null` (replacing the `status==='PAID'` predicate at `invoices.service.ts:495` + FE `canEditNumber`).
- **194C read-sites repoint** — the 4 `isSeparatePayout` reads (`tds.service` 194R-exclude + 194C-include, `invoices.generateForPeriod`, `credits.createPayoutDownload` split) switch to `payoutStream=VISIBILITY`. Compute groups by the FROZEN `tdsSection`, not live config.
- **DEDUCT engine** — writes `tds_deduction_entries` at `createPayoutDownload` (where the bank net is set); reduces the outlet's bank-file line by the deduction; sets `CreditPayoutEntry.tdsDeductedPaise`. Carry-forward = latest `carryForwardPaise` per (PAN, section, FY).
- **GROSS-UP engine** — at threshold crossing, create/upsert the TDS `AutoInvoice` (kind=TDS, `linkedPanNumber`/`linkedFyLabel`, body=TDS, GST applies) and append `tds_recovery_entries` pro-rata across the PAN's contributing tenants. "In lieu of TDS" label is dashboard-only.
- **GST holdback** — SERVICE invoice generation creates a `GstReimbursement(status=HELD, gstPaise)` for GST-registered retailers; Gifsy-only release screen flips to RELEASED with proof + payout ref.
- **Legend/narration** — `buildInvoiceDescription` → `"Payment for Marketing and support services for the month of <Month, Year>"`; legend (3 sites: `VisibilityInvoicePDF.ts`, partner detail, partner list) → `"This is an automated invoice. No Signature is required."`

## 6. Where the Wave 3 dual money-path audit concentrates (per the industry review's calibration)

The config store is low-stakes; the real risk is the **compute + ledgers**: PAN-level cross-tenant aggregation,
the ₹30k-single/₹1L-FY threshold crossings + the retroactive jump, gross-up paise rounding
(`roundToRupeePaise`), DEDUCT carry-forward correctness across periods/tenants, recovery pro-rata summing to the
exact TDS deposited, idempotency (a retried confirm/UTR must not double-invoice, double-deduct, or double-recover),
and the frozen-stamp being read (never a live config re-lookup). That is where the two auditors spend their time.

## 9. AS-BUILT — decisions + audit/fix log (2026-07-28)

**Owner decisions locked this session** (on top of D1–D14):
- **W0-A config store = JSON-hardened** (not a typed table — validated against the codebase convention + industry
  best-practice: Stripe immutable/effective-dated tax rates, Fowler Effectivity+Snapshot+Audit-Log). Fail-closed
  is **scoped to `resolveTdsPolicy`** (throws on malformed) so `getEffectiveSettings` stays robust for unrelated
  reads; **W0-B freeze-on-confirm** stamps section+methodology by value onto each `CreditPayoutEntry`.
- **D-i gross-up = MONTHLY-INCREMENTAL** top-up invoices `TGSL-TDS-<PAN>-<FY>-<seq>` (each period after crossing
  raises a top-up for that period's additional TDS + delta recovery; Σ top-ups over the FY = grossUp(full base)).
- **D-ii no-PAN = pay full + 20% TENANT recovery + report** (recovery keyed `__NO_PAN__:<outletCode>`, telescoped
  off the recovery ledger; report exposes an `isNoPan` boolean — FE must use that, not the raw string).
- **D-iii rollout = default-ON.** **D10 recovery = pro-rata by each tenant's FY-aggregate base** (honored).

**Build + verification path:** W0 schema/migration (ADDITIVE) → W0.5 shared contracts → W1 3 parallel streams
(A tds-compute, B credits+invoices write-orchestration, C `api/src/tds-invoicing/*` reimbursement+reports+config)
→ integrated (`CreditsModule`→`InvoicesModule`, new `TdsInvoicingModule`→`AppModule`) → **DUAL money-path audit
(8 findings) → fix pass (9) → DUAL re-audit (4 findings) → fix cycle 2 (6) → FINAL re-audit CLEAN (0 defects)**.
Gate: **api nest build 0 / jest 92 suites 2023 tests · FE tsc 0.** Deoleo's live incentive/194R path is
**byte-identical** — the TDS engine is a no-op for single-tenant/single-methodology/incentive payouts.

**Key defects found + fixed** (money-path audit earned its keep): gross-up one-shot under-deposit → monthly
incremental; DEDUCT liability used the gross-up factor → branched to withholding `rate/100`; aggregation reads
outside the tx → moved inside + per-PAN `pg_advisory_xact_lock`; DEDUCT ledger not reversed on FAILED → compensating
negative row keyed by `creditPayoutEntryId`; FY anchor period-vs-paidAt → both sides use `fyForPeriod(period)`;
TDS invoices born-locked + number immutable; per-period attribution violated D10 → pro-rata by FY-aggregate true-up;
no-PAN double-count on FAIL→re-bank → ledger-telescoped; MIXED cross-tenant PAN base cross-contamination → partitioned
by methodology (threshold on combined base); payout-report outlet join (code-vs-PK) fixed.

**⚠️ NOT yet applied to any DB** — local Postgres was down; both migrations apply + get runtime-verified on staging
at W3 (prior-wave pattern): `20260728120000_visibility_payout_tds_foundation` (the TDS feature) **and**
`20260728130000_credit_code_per_tenant_unique` (the code-collision fix below). **✅ FIXED this wave (owner "fold it in"):**
the `batchCode`/`downloadCode` global-unique collision — codes are now `@@unique([clientId, code])` (per-tenant, not
global) + generated under a per-(clientId, period) `pg_advisory_xact_lock` so same-tenant concurrent creates serialize.
Additive-safe (existing globally-unique rows are trivially unique per tenant). **Still parked (dormant, 2nd-tenant
checklist):** a low-severity double-reversal edge on an already-reversed PAID entry. **Residual for CA/UAT:** no-PAN
threshold is per-(clientId, outletCode) since cross-tenant
aggregation needs a PAN; MIXED cross-tenant methodology is a live multi-tenant scenario now handled but unexercised.

**STATUS: LIVE ON STAGING (`500eaf9`) + runtime-verified. ▶ NEXT = owner UAT → W4 owner-gated prod cutover.**

## 10. DEFERRED DECISIONS — pending, pick up later (owner-parked)

**DD-1 — Tenant recovery report exposes the cross-tenant PAN aggregate (privacy). PARKED "keep as-is" 2026-07-29 (owner).**
- **What:** `tds-reports.service.ts` `recoveryReport()` (and `recoveryReportXlsx()`) return `panBase` (the PAN's base
  aggregated across ALL 194C tenants) and `panTdsTotal` (the PAN's total TDS) on **every row, including a tenant-scoped
  (CLIENT_ADMIN) call** — alongside the tenant's own `tenantBase`/`tenantShare`. The row set is correctly clientId-filtered,
  but each row still carries the platform-wide totals.
- **Consequence:** when the SAME retailer PAN is paid under ≥2 different 194C tenants, a tenant admin can compute
  `others' total = panBase − my tenantBase` — learning the EXACT amount other brands paid that shared retailer. It reveals
  **amounts only for one shared PAN** — never the other tenant's identity, outlets, employees, or business. Weaker inference
  (that a shared retailer exists elsewhere) is unavoidable anyway, because a sub-threshold tenant still gets a recovery bill.
- **Scope/severity:** LOW + DORMANT. Only triggers with a 2nd live 194C tenant sharing a retailer PAN; never for Deoleo alone.
- **Owner decision (2026-07-29):** **KEEP AS-IS for now** (arguably useful "here's why you're charged" transparency);
  revisit later, likely with CA input.
- **Fix when picked up (small/surgical):** in `recoveryReport()` + `recoveryReportXlsx()`, when `scope.clientId` is set
  (tenant call), OMIT `panBase` + `panTdsTotal` from the row DTO and the xlsx columns ("PAN Base (₹)", "PAN TDS Total (₹)");
  keep them for the GIFSY platform-wide view (`scope.clientId` undefined). Add a CLIENT_ADMIN-scoped test asserting the two
  fields are absent. No schema/migration change.

**DD-2 — Double-reversal edge — ✅ EXERCISED + CLOSED (2026-07-29, synthetic 2-tenant staging run).**
Drove a DEDUCT payout (outlet SYNTH-B3, ₹40,000, PAN AAAPB3333C) to PROCESSING via a real payout-download (withheld
₹400 = 40000 paise), then a UTR upload marking it **FAILED** → the guarded `PROCESSING→FAILED` flip zeroed `tdsDeductedPaise`
and appended **one** compensating `TdsDeductionEntry` of **−40000 paise**. **Re-applied the identical UTR file** (`apply=true`)
→ response `{paidCount:0, skippedCount:2, failedCount:1}` and, at the DB, the deduct ledger for AAAPB3333C held **exactly 2
rows (+40000, −40000), net 0** — the re-apply added **no** third row (the entry was already FAILED, not PROCESSING, so
`flip.count===0 → continue`). **Idempotent; no double reversal on the guarded path.** No code change needed.

**DD-3 — No-PAN per-(clientId, outletCode) + MIXED cross-tenant methodology — ✅ EXERCISED + CA-READY (2026-07-29, synthetic run).**
Two synthetic 194C tenants — `synthtdsa` (GROSS_UP) + `synthtdsb` (DEDUCT) — sharing retailer PAN `AAAPS1234C`, plus a no-PAN
outlet under each. Every number the live engine produced matched hand-calc to the paise:
- **MIXED shared PAN** `AAAPS1234C`: platform 194C row base **₹90,000**, `methodology` effectively MIXED, liability **₹904**
  (= ₹500 withheld from B1 [DEDUCT] + ₹404 gross-up TDS invoice from A1 [GROSS_UP]); the two methods computed on their own
  base with no contamination (frozen-per-entry stamp).
- **No-PAN per-(clientId, outletCode):** A2 (no-PAN, ₹40,000 > ₹30k) → recovery **₹10,000** written (`__NO_PAN__:SYNTH-A2`);
  B2 (no-PAN, ₹20,000 < ₹30k) → **NO recovery** (below the per-outlet line) — proving no-PAN is NOT pooled across tenants/outlets.
- **The CA artifact (quantified live):** the read-side `compute194C` pools all no-PAN into one `__NO_PAN__` bucket
  (base ₹60,000 → theoretical liability **₹14,000** = ₹10k gross-up A2 + ₹4k withhold B2), while the write-side recovers only
  **₹10,000** (B2 below per-outlet threshold). The **₹4,000 gap = exactly B2's un-recovered slice** — the platform-aggregate
  vs. operational-per-outlet difference a CA should sign off on. No code defect found; behavior is as designed.

**DD-4 — GST charged on the gross-up TDS invoice for a GST-REGISTERED retailer — ⚠️ OBSERVATION, flag for CA review (2026-07-29, from the synthetic run).**
For a `gstRegistrationType=REGULAR` retailer, the **TDS invoice** (`invoiceKind=TDS`, gross-up) is created **with GST** applied
(observed: PAN AAAPA3333C TDS invoice subtotal ₹404 + **GST ₹72.72** = ₹476.72, and a matching `GstReimbursement(HELD)` of ₹72.72),
in addition to the retailer's SERVICE invoice GST (₹7,200 held). Whether a TDS-deposit invoice should itself carry (and hold) GST
is a genuine tax-treatment question — surfaced here so a CA confirms it before a 2nd live 194C tenant. For an UNREGISTERED retailer
the TDS invoice correctly carried `gst=0`. Not a blocker for Deoleo (single-tenant 194R/incentive path unaffected). If the CA says
TDS invoices should not carry GST, the fix is in `invoices.service.ts createTdsInvoice` (skip `computeGST` / GstReimbursement for
`invoiceKind=TDS`).

> **How exercised:** a self-contained synthetic 2-tenant run on staging (clients `synthtdsa`/`synthtdsb`, 6 outlets, PANs
> `AAAP*`), driven entirely through the real HTTP API (tdsPolicy → visibility field → batch → confirm → payout-download →
> UTR), verified via guarded `gifsy_staging` reads, then **fully deleted** (0 rows remain; platform 194C view clean). Isolated
> from Deoleo/uatbajaj/all real data throughout.
