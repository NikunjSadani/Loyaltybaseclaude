# Global Settings → Real, DB-backed, Per-Tenant — Wiring Plan

Status: ✅ BUILT (2026-06-23) — Wave 0 + Wave 1 (all 3 streams) complete, every item
independently audited + audit findings fixed, FULL gate green (api jest 1022/1022, FE vitest
1502, tsc clean both sides). fourEyes DEFERRED per owner. **Remaining: runtime-verify on the
local stack + push (push pending owner ask).** Build log appended at the bottom.
Goal: keep the entire Gifsy Settings panel and make every field a real, tenant-scoped,
backend-enforced setting. No field should be "looks configurable but does nothing."

## Grounding (verified by recon, file:line)

Settings store ALREADY EXISTS and is per-tenant — we extend it, not invent it:
- `ProgramSetting` table, keyed `(clientId, settingKey)`, audit-logged, with
  `getSettings`/`upsertSetting` (`api/src/admin-core/admin-core.service.ts:437-490`).
  `SETTINGS_DEFAULTS` already holds `conversionRate`, `minRedemptionPoints`, `tdsRate`, etc.
- `ClientConfig.features` (AdminConfig + cached `TenantService`) already holds the one
  truly-DB-backed flag: `visibilityCaptureMode` (`tenant.service.ts:86`).

Current reality of each field (all localStorage today unless noted):
- `pointsConversionRate` — REAL but env-driven (`POINTS_CONVERSION_RATE`), held as a
  **constructor `readonly` field** in `rewards.service.ts:59` + `wallet.service.ts:46`;
  used in 4 money methods (redeem/confirm ×2 paths) + `wallet.getWallet` + returned by
  `auth /me:76`; boot-guarded `main.ts:60`. THREE divergent copies (env, ProgramSetting
  default, localStorage).
- `minBankTransferAmount` / `minVoucherFreeAmount` — localStorage only, **zero backend
  enforcement**. (Per-item `minRedemptionPoints` is the only real cash floor today.)
- `redemptionChannels{physicalGifts,vouchers,bankTransfer}` — localStorage; only effect is
  hiding partner tabs off static defaults (`partner/rewards/page.tsx:945`); no server gate.
- `creditsPayouts.*` — ALL frontend-only: `safetyCapPoints/Inr` enforced only in the FE
  parser (`credits-payouts-parser.ts:219`); `monthCutoffDay` only a FE upload-window banner;
  `notifyEmails` ignored — backend hardcodes `ops@gifsy.in` (`credits.service.ts:267`);
  **`fourEyesEnabled` concept is ENTIRELY ABSENT** (no approval status; batch goes
  PENDING_CONFIRM→CONFIRMED in one action).
- `paceAmberThreshold` — FE-only; classification in `lib/pace.ts:35`, 6 consumers.
- `salesApp.ledgerLabel` / `redeemGiftWholesalerOnly` — FE-only UI label + gate
  (`sales/kyc/[id]/page.tsx:845-846`).
- `visibilityPhotoEnabled` — FE-only, but **overlaps** the already-DB-backed
  `visibilityCaptureMode`. Consolidate, don't duplicate.

Every backend entrypoint that needs a setting already receives `user.clientId` (JWT). Good.

## Three findings that change the design (must be in scope)

1. **Money-correctness — freeze the rate on the order.** Today env rate is constant, so
   redeem-time and confirm-time math always agree. Once the rate is per-tenant AND
   admin-editable, an admin can change it between a partner's `redeem()` (computes
   `requiredPoints`, stored as `totalPointsCost`) and the OTP `confirmRedeem()` (recomputes
   `valuePaise`/TDS base from the live rate, `rewards.service.ts:558,936`). That would debit
   points at rate R1 but value the payout/TDS at R2. FIX: snapshot the rate on
   `RedemptionOrder` at create; confirm uses the snapshot. → one nullable column
   `RedemptionOrder.conversionRateCenti` (Opus-authored migration in Foundation).

2. **`fourEyesEnabled` is a NEW WORKFLOW, not a config read.** No PENDING_APPROVAL status,
   no second-approver. Treating it like the other flags would silently no-op. It is broken
   out as its own optional unit (Unit D) with its own schema migration + audit, and is the
   one item I recommend you explicitly accept or defer.

3. **`conversionRate` is hot-path** → the settings reader must cache per-clientId (TTL +
   bust-on-write), mirroring `TenantService`, or every redeem adds a `ProgramSetting`
   `findMany`.

## Design decisions (locked unless the auditor/owner objects)

- **Single home = `ProgramSetting`** (extend keys) for all scalar/JSON settings.
  `visibilityCaptureMode` stays in `ClientConfig.features` (already there); fold
  `visibilityPhotoEnabled` into it (add no parallel store).
- **New `TenantSettingsService`** (api, @Global): typed getter merging `SETTINGS_DEFAULTS`
  over `ProgramSetting` rows for a `clientId`; per-clientId cache w/ bust on `upsertSetting`.
  `conversionRate` default = `POINTS_CONVERSION_RATE` env (preserves today's behavior +
  keeps the boot guard as a global sanity floor). Upsert validates each key (rate finite>0,
  caps ≥0, channel booleans, emails well-formed).
- **FE delivery**: extend `GET /v1/auth/me` (already returns `conversionRate`) with the
  partner/sales-relevant settings block; rewrite `lib/gifsy-settings.ts` internals to read
  that server block (keep `getGifsySettings()` signature so call-sites barely change) and
  drop localStorage as the source of truth. Admin Gifsy-Settings panel + admin settings page
  write via `upsertSetting` (real save), not localStorage.
- **Channel map**: PHYSICAL_GIFT→physicalGifts; VOUCHER/GIFT_CARD→vouchers;
  UPI/BANK_TRANSFER→bankTransfer.
- **Global cash floor semantics**: at redeem, for cash modes, `requiredPoints` must also be
  ≥ `round(minBankTransferAmount × rate)` (bank) / `round(minVoucherFreeAmount × rate)`
  (voucher) — a floor ON TOP of the per-item `minRedemptionPoints`.

## Audit fixes folded in (independent plan review, 2026-06-23)

An independent adversarial review (verdict: SOUND-WITH-CHANGES) found 2 blockers + 4 majors.
All are now incorporated below:
- **(BLOCKER C1/P2)** There is a SECOND localStorage write-surface the first draft missed:
  `admin/gifts/page.tsx:1520-1652` (`GifsySettingsPanel`) reads+writes `redemptionChannels`,
  `pointsConversionRate`, `minBankTransferAmount`, `minVoucherFreeAmount` via
  `saveGifsySettings`. It is now explicitly assigned to Stream MONEY-REWARDS and must be
  converted to `upsertSetting`, else saves silently no-op after the lib is server-sourced.
- **(BLOCKER P1)** Wave-1 streams are NOT file-disjoint — they share `lib/gifsy-settings.ts`
  and the `GifsySettings` type (`types/index.ts:444-495`). FIX: **Unit 0 emits the COMPLETE
  settings type + the full lib shape up front (all groups)**; Wave-1 streams then edit ONLY
  their consumers, never the shared lib/type.
- **(MAJOR F1)** `getGifsySettings()` is SYNC today (localStorage) and called inline at render
  by 18 consumers. Server-sourcing makes it async → flicker-to-defaults. FIX: Unit 0
  **hydrates the `/me` settings block into a synchronous client store at login** (React
  context seeded once + a localStorage write-through cache) so `getGifsySettings()` keeps a
  sync signature backed by server data; consumers don't change.
- **(MAJOR M1/X3/X2)** The ONLY confirm-time live-rate read that drifts is the `valuePaise`
  computation (points are already frozen via `order.totalPointsCost`). FIX: freeze ONLY
  `valuePaise`'s rate in all **four** methods — `redeem:748`, `redeemForOutlet:345`,
  `confirmRedeem:936`, `confirmRedeemForOutlet:558` — reading `order.conversionRateCenti ??
  liveRate` (fallback keeps pre-migration PENDING orders working; `getWallet`/`/me` stay live
  previews, NOT frozen).
- **(MAJOR F3)** Cache-bust crosses a service boundary: `upsertSetting` lives in
  `admin-core.service.ts:463`, the cache in the new `TenantSettingsService`. FIX: upsert must
  notify the settings cache to invalidate. Also make `conversionRate` default env-derived in
  BOTH the new service AND `SETTINGS_DEFAULTS:439` (currently a divergent literal `1`).
- **(MAJOR X1/F0)** Define precedence: the global cash floor WINS and per-item
  `minRedemptionPoints` must be validated ≥ global at catalog-create (avoid unsatisfiable
  items + confusing double-block errors). And `TenantSettingsService` must **deep-merge**
  nested setting objects (`creditsPayouts`, `salesApp`, `redemptionChannels`) over defaults —
  the current shallow `settings[key]=value` would drop sibling defaults on partial override.

## Work units (1 unit = executor → independent audit → full gate → runtime-verify)

- **Unit 0 — Foundation (sequential, keystone).** `TenantSettingsService` (typed getter,
  deep-merge defaults, per-clientId cache + cross-service bust hook for `upsertSetting`);
  upsert validation per key; the COMPLETE `/auth/me` settings block (all groups, one shot);
  the login-time **sync hydration store** so `getGifsySettings()` stays sync over server data;
  the final `GifsySettings` type in `types/index.ts` (frozen here so Wave-1 never edits it);
  env-derived `conversionRate` default in the service AND `SETTINGS_DEFAULTS:439`;
  Opus-authored additive migration adding `RedemptionOrder.conversionRateCenti` (nullable).
  Everything depends on this. **Both admin write-panels keep working only after this lands.**
- **Unit 1 (Stream MONEY-REWARDS) — conversionRate + min-thresholds + channels.** Replace
  the two `readonly conversionRate` fields with per-`clientId` lookups in all 4 money methods
  (`redeem:748`, `redeemForOutlet:345`, `confirmRedeem:936`, `confirmRedeemForOutlet:558`) +
  the live preview reads in `wallet.getWallet`; freeze ONLY the `valuePaise` rate on the order
  at redeem, read `order.conversionRateCenti ?? liveRate` at confirm; add the global cash-floor
  min enforcement (global wins; validate per-item min ≥ global at catalog-create) + server-side
  channel-enabled rejection in BOTH `redeem` and `redeemForOutlet`; partner FE reads
  channels/min from the server block. **Also converts the `admin/gifts/page.tsx`
  `GifsySettingsPanel` (rate/channels/min writes) from `saveGifsySettings` → `upsertSetting`.**
  Touches `rewards.service.ts` + `wallet.service.ts` + `partner/rewards/page.tsx` +
  `admin/gifts/page.tsx`. HEAVY money audit. (A+B merged — both rewrite the same redeem/confirm
  methods; cannot be two parallel executors on one file.)
- **Unit 2 (Stream MONEY-CREDITS) — caps + cutoff + notifyEmails (+ hide fourEyes toggle).**
  Enforce `safetyCapPoints/Inr` and `monthCutoffDay` in `credits.service.ts` at batch
  create/confirm (backend is currently wide open); route batch-confirm notification to the
  configurable `notifyEmails` instead of hardcoded `ops@`; **hide/disable the deferred
  `fourEyesEnabled` toggle** in the settings panels. Touches `credits.service.ts` +
  credits-payouts FE. Credit-rail money audit. DISJOINT from Unit 1 (different service files)
  → runs PARALLEL.
- **Unit 3 (Stream FE-ONLY) — pace + salesApp + visibility.** Point `paceAmberThreshold`,
  `salesApp.*`, `visibilityPhotoEnabled` consumers at the server settings block; consolidate
  `visibilityPhotoEnabled` onto `visibilityCaptureMode`. FE-only, non-money. DISJOINT → runs
  PARALLEL with Units 1 & 2.
- **Unit D — fourEyesEnabled approval workflow — DEFERRED (owner decision 2026-06-23).**
  Not built in this effort. It is a genuine NEW workflow (no second-approver concept exists
  today), out of scope for go-live; single-approver credit-batch confirm is the accepted
  launch posture. When picked up post-go-live it needs: new `CreditBatchStatus.PENDING_APPROVAL`
  + `approvedBy`/`approvedAt` column + second-approver guard (approver ≠ uploader/confirmer) +
  admin approve/reject UI + schema migration. → tracked in `POST-GO-LIVE-BACKLOG.md`.
  **Because it is deferred, Unit 2 must HIDE/disable the `fourEyesEnabled` toggle in both
  settings panels** so it does not present as an active control (the whole point of this
  effort: no setting that pretends to work).

## Parallelism map (how the agents run)

- **Wave 0:** 1 executor → Unit 0 (Foundation). Barrier — nothing else starts until it lands
  + passes its audit + gate.
- **Wave 1:** 3 executors in parallel on DISJOINT files:
  Stream MONEY-REWARDS (`rewards/wallet` svc + partner page) ‖
  Stream MONEY-CREDITS (`credits` svc + credits FE) ‖
  Stream FE-ONLY (pace/sales/visibility FE).
  Then 3 INDEPENDENT auditors in parallel — one per stream, each handed the PROBLEM to
  re-derive (not my diff to rubber-stamp); money streams get adversarial money audits.
- **Wave 2 (only if Unit D greenlit):** 1 executor → fourEyes (after Stream MONEY-CREDITS
  merges, since same file) + Opus migration + independent audit.
- **Wave 3:** Opus runs the FULL gate (api jest + FE vitest + tsc both sides), runtime-verifies
  each flow on the local stack (rate change reflects in redeem math; disabled channel hides +
  is server-rejected; cap/cutoff rejected at the API not just the FE; notify email routes;
  pace/label/visibility reflect per tenant), then doc + memory sweep.

Collision safety (corrected after audit): the shared `lib/gifsy-settings.ts` and the
`GifsySettings` type are FROZEN in Unit 0 — Wave-1 streams edit only their own consumer files,
never the shared lib/type, so they are then disjoint. File assignment is explicit:
`admin/gifts/page.tsx` → Stream MONEY-REWARDS (money-setting writes); `admin/settings/page.tsx`
+ the 6 pace consumers (`partner/dashboard:118`, `partner/targets:121`, `sales/dashboard:87`,
`sales/team:59`, `sales/outlets:79`, `components/schemes/scheme-card.tsx:87`) + sales-app +
visibility → Stream FE-ONLY. `schema.prisma`/migrations are Opus-owned and confined to Unit 0
(+ Unit D), so executors never collide on schema. All three streams only CONSUME the `/me`
block; only Unit 0 writes `auth.service.ts`.

## Out of scope / risks to call out

- Changing a tenant's rate does NOT retro-value already-confirmed orders (correct — they are
  frozen). Only new redemptions use the new rate. State this in the admin UI.
- `notifyEmails` currently also implicitly documents who Gifsy notifies; moving to per-tenant
  config means each tenant's batch notifies that tenant's configured ops list — confirm intent.
- Migrations run on staging/prod via the in-VPC job; both migrations here are additive
  (nullable column / new enum value) → safe, no backfill.

## Build log (2026-06-23) — as-built

**Wave 0 — Foundation (Opus, audited SOUND-WITH-CHANGES → hardened):**
- `api/src/tenant/tenant-settings.service.ts` — @Global `TenantSettingsService`: typed
  `EffectiveSettings`, env-derived conversionRate default, ProgramSetting overlay with
  per-key validation + deep-merge of nested objects, per-clientId cache + `invalidate()`,
  throw-safe fallback to defaults. `+ .spec.ts` (9 tests).
- `api/src/tenant/tenant-settings.controller.ts` — `GET /v1/settings` (any authed, tenant-scoped;
  omits `creditsPayouts` for non-admins; includes authoritative `visibilityCaptureMode`).
- `tenant.module.ts` registers both. `admin-core.service.ts` busts the cache on `upsertSetting`
  + env-derived conversionRate default. `auth.service.ts` `/me` carries a `settings` block +
  `visibilityCaptureMode`.
- Migration `20260623120000_redemption_order_conversion_rate_centi` (nullable, additive).
- `platform/src/lib/gifsy-settings.ts` rewritten: sync `getGifsySettings()` over a localStorage
  write-through cache, server refresh, real `saveGifsySettings` (PUT), `useGifsySettings()` hook.
- Hardening from the Foundation audit: deep-merge contract documented (replace-whole nested keys),
  caps/cutoff redacted from non-admin `/settings`, `monthCutoffDay` clamped 1–31.

**Wave 1 — Stream MONEY-REWARDS (Opus, audited SOUND):** `rewards.service.ts` — per-tenant rate
via `TenantSettingsService` in all 4 money methods; rate SNAPSHOT on the order
(`conversionRateCenti`) at redeem + confirm reads the snapshot (`order.conversionRateCenti ?? live`)
so an admin rate edit can't shift TDS/payout value; server-side channel-enabled rejection + global
cash/voucher floor in BOTH redeem paths; `wallet.getWallet` per-tenant rate; `admin/gifts`
GifsySettingsPanel gated to GIFSY_ADMIN + save-error surface. Tests: freeze, channel, floor, snapshot.

**Wave 1 — Stream MONEY-CREDITS (agent, audited SOUND):** `credits.service.ts` — server-enforced
safety caps (points + INR units) at batch create, month-cutoff window (mirrors the FE rule) on
create + confirm, configurable `notifyEmails` (fallback to ops@ when empty). fourEyes left inert.

**Wave 1 — Stream FE-ONLY (agent, audited SOUND-WITH-CHANGES → fixed):** visibility consolidation
(`photoActive = captureMode==='PHOTO_APPROVAL' && visibilityPhotoEnabled`) in sales/kyc +
admin/visibility; salesApp via `useGifsySettings()`; pace consumers already correct; admin/settings
pace-save real + read-only for non-GIFSY. **Audit HIGH fixed:** sales couldn't read the admin-only
capture-mode endpoint (403→wrong default) → `visibilityCaptureMode` now surfaced via `/me` + `/settings`
and the sales/kyc page reads it from the settings hook.

**Deferred / noted:** fourEyes approval workflow → `POST-GO-LIVE-BACKLOG.md`. Non-blocking audit
nits: admin/visibility reads the display flag non-reactively (LOW); sales/kyc local `paceBadge`
hardcodes 15 (pre-existing, out of scope).
