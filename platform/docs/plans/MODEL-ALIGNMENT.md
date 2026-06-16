# Model-Alignment Findings (2026-06-16)

A read-only sweep triggered after two inherited concepts (Catalog/SKU, point-tiers) were found not to
fit the platform's real model. It found the mismatch is **systemic, not incidental**.

## The platform's REAL model (owner-confirmed)
- **Sales/achievement upload is TARGET-PARAMETER based** — tenants upload **final amounts per outlet per
  parameter**. The platform **does NOT compute** points/incentives.
- **Segmentation is by PROGRAM** (`programName` + `programCategory`), captured **per-outlet at outlet upload**.
  This **replaces the legacy "partner class"** (GOLD/SILVER) concept.
- No SKU/invoice line-item billing; no point-tier progression/multipliers.

## The big finding — three disconnected layers
1. **World A — inherited DB/loyalty engine** (`prisma/schema.prisma` + `src/app/api/**` + `lib/incentive.ts`,
   `lib/wallet.ts`): full PartnerClassConfig / TierConfig / Wallet / PointsLedger / SKU-invoice **incentive
   compute**. **Mostly NOT wired to any UI.** Contradicts the no-compute model.
2. **World B — demo UI on mock data** (`scheme-builder.tsx`, `lib/schemes.ts`, dashboards/profile): uses a
   *separate* `ChannelPartnerClass` enum (GOLD/SILVER) that is **decorative** — see below.
3. **World C — the REAL model, newer slice** (`lib/outlet-upload.ts`, `outlet-persist.ts`,
   `Outlet.programName/Category`, `Credit*` models, `api/admin/credits/**`): parameter upload, program on outlet,
   stores numbers **verbatim** (no compute). This is what we've been building on in P2.

## Per-concept verdict

| Concept | Reality found | Verdict |
|---|---|---|
| **Point tiers** (`TierConfig` minPoints/maxPoints/**pointsMultiplier**, `PartnerTierHistory`, `ChannelPartner.currentTierConfigId`) | `pointsMultiplier`/`minPoints` **never applied in any computation** — stored/CRUD'd only. Settings "Tier Management" card is local-state mock (no save). | **DROP** (pure deletion; no logic rewrites). |
| **Partner class** (`PartnerClassConfig`, `enum PartnerClassCode`, `enum ChannelPartnerClass`, `applicableClasses`, `eligibleClasses[]` on reward/visibility/leaderboard/banner) | **Already decorative.** Scheme eligibility (`lib/schemes.ts:336`) actually keys off **outlet TYPE**, not class; the builder's GOLD/SILVER selector only renders badges. KYC's `partnerClass` field holds **outlet-type values** (SSS/WHOLESALER), mislabeled. Nothing functional depends on class. | **RETIRE → replace with program.** Low functional risk, wide DEFINE-layer footprint. |
| **Program** (`Outlet.programName/Category`) | **No `Program` entity** — two text columns + per-tenant valid-lists in Settings. **Nothing targets/segments by program yet.** | **Make it the real segmentation dimension** (net-new targeting, not a rename). |
| **Incentive/points compute** (`lib/incentive.ts` slab/overachievement/`pointsPerRupee`, `api/schemes/calculate`, `Scheme.pointsPerRupee/fixedPoints`) | Live in World A, **disconnected from UI**; assume SKU/invoice accrual. The correct path (`api/admin/credits/**`, `OutletSalesRecord.kpiValues`) stores uploaded numbers verbatim. | **REMOVE/retire** the compute engine; standardize on upload-final. |
| **Catalog/SKU** | (already reverted) | DONE. |
| **2.2 sales-user CRUD / 2.5 outlet UI** | Zero references to class/tier/SKU; 2.5 already consumes program. | **Clean — safe to finish.** |

## Why this matters: tiers and partner-class are ENTANGLED
`TierConfig` hangs off `PartnerClassConfig`; both are part of the same inherited loyalty engine. Dropping
tiers in isolation = one migration now, then another when partner-class goes = exactly the churn this pass
exists to prevent. They should be handled as **one coherent loyalty-engine de-scaffold**.

## De-scaffold scope (one coherent effort)
**Schema (one migration):** drop `TierConfig`, `PartnerTierHistory`; drop `ChannelPartner.currentTierConfigId`
+ relations; `SchemeEligibility.tierConfigId`; `RuleType.TIER_CONDITION`. Partner-class retirement (if full):
`PartnerClassConfig`, `enum PartnerClassCode`, `ChannelPartner.partnerClassId`, `Client.partnerClasses`,
`eligibleClasses[]`/`targetClasses[]` on RewardCatalog/VisibilityProgram/LeaderboardConfig/BannerManagement,
`PointExpiryConfig.partnerClassCode`, `enum ChannelPartnerClass` (types). **All stored-only → safe to drop.**
**Code:** delete `api/admin/tiers/route.ts`; strip tier/class from `api/admin/channel-partners/*`; remove
Settings Tier-Management card; replace `partnerClass` filters/badges (filter-bar, dashboard, payouts, profile,
reports metadata) with program; drop the `Partner Class` column in `outlet-master-export.ts` (program cols
already beside it). **Compute:** retire `lib/incentive.ts` + `api/schemes/calculate` (or quarantine until P5/P6
reconcile decides).

## Net-new to BUILD (the replacement, not a rename)
**Program-based scheme targeting:** a program selector in `scheme-builder.tsx` (replacing the decorative
`applicableClasses` UI) + an eligibility matcher against `Outlet.programName/programCategory`. Belongs in **P4**.
Optionally a real `Program`/`ProgramCategory` master (per-tenant) if validation should be DB-backed rather than
Settings-JSON.

## Sequencing — the de-scaffold is now part of PHASE S (the backend split)
> **Alias note:** other docs call this the **"P4.0 de-scaffold."** Same scope — it is now **executed in Phase S
> step S2** (the backend is built clean rather than de-scaffolded-then-ported). "P4.0" = Phase S / S2.
**Owner decision 2026-06-16 (Gap #31): this de-scaffold is executed inside [`BACKEND-SPLIT-PLAN.md`](BACKEND-SPLIT-PLAN.md)
step S2.** We are NOT de-scaffolding the platform then porting — instead we build the new NestJS backend **clean on
the real model**: take the platform schema, **drop the World-A concepts below in one human-gated migration**, and
the backend never carries them. So "drop `lib/incentive.ts` / `api/schemes/calculate`" = those simply are **not
ported** into the backend; the schema drops happen in S2.
- The removal list (tiers + partner-class + compute + SKU, exact per-file) above is the **S2 checklist**.
- **Program-based scheme targeting is net-new P4 work** (program selector + matcher vs `Outlet.programName/Category`),
  built **in the backend** after Phase S — not a rename.
- This still reshapes P4 (schemes/targets → program-based, no compute), P5 (wallet/points), P6 (credits/incentive).
