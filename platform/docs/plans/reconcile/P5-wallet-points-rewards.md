# P5 — Wallet, Points & Rewards — Reconcile + Build Record

> **Status: P5 COMPLETE ✅ (2026-06-18).** Backend (5.0–5.4b) + FE (5.5a/b), all independently audited,
> committed + pushed to `develop` (≤ `51231fc`). Migration applied to gifsy_dev. Backend jest 596,
> platform tsc 0, partner+admin vitest green; the 5 P5 wallet TDD reds resolved. **#28 closed**;
> #16 IN-path primitive ready for P6; #18-gift resolved. Build record below + [[p5-complete]].
> Read [[platform-real-model]] + [[reconcile-fit-before-build]] + [[architecture-backend-split]].

P5 = spec §02 Workflow 4 (Points Redemption) + capabilities §9 (Wallet & Points) / §10 (Rewards &
Redemption). **This is reconcile + wire-up, not build-from-zero** — every P5 schema model already
exists, and Phase S S4 already re-homed read-side wallet/rewards routes onto `/v1`.

---

## §1 · The model (owner-confirmed at kickoff — do not relitigate)

- **No compute (the platform spine).** Points do not get *computed* anywhere. Earn arrives as
  **final amounts**: admin **wallet adjust** (P5) and the **Credits module** (P6, Gap #16). P5
  builds the wallet/ledger **primitives**; it does not invent an earn engine.
- **Points lifecycle = expiry now, holding deferred.** Expiry (`PointExpiryConfig`) is built in 5.2.
  The **holding/lock period** lost its config home when `TierConfig` was dropped (S2); it is **not
  built now** (no tenant uses it). The schema fields survive (`PointsLedger.lockedUntil`,
  `Wallet.lockedPoints`, `LOCK_HOLDING`/`UNLOCK_HOLDING`, `PointsLedgerType.LOCK/UNLOCK`), so adding
  it later is ~½ day with **no migration** — a symmetric unlock-sweep mirroring the expiry sweep.
- **Catalogue = one real table.** Resolve the split-brain (admin writes a `ProgramSetting` JSON blob;
  partner reads the real `RewardCatalog` table) by building **real CRUD on
  `RewardCategory`/`RewardCatalog`** and **retiring** the `gift-config` blob + `lib/gifts.ts` demo.
  Inventory = a single nullable `stockQuantity` column (the spec's `RewardInventory` entity is a
  **phantom** — no such model — see §4).
- **Redemption = P5 debits points + owns fulfilment; P6 owns only the INR cash rail.** The points
  **debit is identical** for gift / voucher / INR — partner redeems, OTP confirms, `redeemablePoints`
  decrement, order created. What differs is settlement:
  - **GIFT_CARD / VOUCHER** → Gifsy provisions a **`voucherCode`** (inline or bulk upload) on the
    `RedemptionOrder`; partner copies it on the order page. **Fully P5.**
  - **PHYSICAL_GIFT** → Gifsy sets **`trackingNumber`/`trackingUrl`** + advances status. **Fully P5.**
  - **UPI / BANK_TRANSFER (points→INR)** → P5 creates the **debited** order only; the cash settlement
    (download→pay→upload-UTR, `FundLedger`, TDS) reuses the **P6 payout engine**, linked via the
    existing `PayoutTransaction.redemptionOrderId`. Bank/UPI detail is **snapshotted from verified
    KYC at payout-creation time in P6** — P5 stores nothing bank-related on the order.
- **Fulfilment is Gifsy-ops-driven, both inline and bulk.** Per-order entry on the order detail
  screen **and** a bulk Excel **download → fill `voucherCode`/`trackingNumber` → upload** (matches
  the payout flow; reuses the shared xlsx builder + P4 parser pattern). No self-service status changes.

> **Why voucher code on the order, not on `PayoutTransaction`:** `PayoutTransaction` is the P6 cash
> entity (batch, TDS, NOT-NULL `amountPaise`/`netAmountPaise`). Parking a gift-card code there would
> force a zero-rupee payout row with stubbed money fields — exactly the speculative cross-wiring
> [[reconcile-fit-before-build]] warns against. `PayoutTransaction.giftCardCode` is left as a
> **legacy field for a future automated provider integration**, documented as NOT the P5 path. This
> also makes "only INR defers to P6" literally true.

---

## §2 · Reuse audit (what exists)

**Backend (`api/src/`) — built in Phase S S4, REUSE:**
| Area | State | Action |
|---|---|---|
| `wallet/` — `getWallet`, `adjust` (GIFSY), `listTransactions` (8 specs) | working, tenant-scoped | **harden + fix `adjust` bug** (5.1) |
| `rewards/` — catalog read (affordability), orders list/get, `updateOrder` (GIFSY, 12 specs) | working | reuse reads; **replace blind `updateOrder` with a guarded transition** (5.4) |
| `admin-core/gift-config` — GET/PUT a `ProgramSetting` JSON blob | World-B demo | **retire** (5.3) |
| `notifications/` enqueue seam (S3) | working | reuse for redemption events |
| `auth` OTP — `OtpCode` (phone+`purpose`+`userId`), generate/verify | working | reuse mechanism for `REDEMPTION_CONFIRM` |

**Schema (`api/prisma/`) — all P5 models EXIST:** `Wallet`, `WalletTransaction`, `PointsLedger`,
`PointExpiryConfig`, `RewardCategory`, `RewardCatalog`, `RedemptionOrder`, `RedemptionStatusHistory`
(unused today) + enums. Delta = §3.

**Platform `lib/` (reference only — retires with platform ~P6):** `lib/wallet.ts`
(credit/debit, **no `PointsLedger`** = #28), `lib/gifts.ts` + `redemption-store.ts` (localStorage
demos), `app/api/rewards/redeem{,/confirm}` (the **unported** real redeem logic — port reference for
5.4; uses OTP `REDEMPTION_CONFIRM` + `sendNotification`).

**FE (thin, partly wired):** `partner/wallet` already fetches `/api/wallet` + `/transactions` (still
imports `loadRedemptions` — drop it); `partner/rewards` fetches `/api/rewards/catalog` but falls back
to `loadGifts` + redeems via `saveRedemption` (localStorage) — needs the real flow; `admin/gifts`
posts the blob. Retiring the blob touches **3 FE pages + 2 wiring tests** (`admin/gifts`,
`sales/catalogue`, `partner/rewards`; `admin-pages-wiring`, `sales-pages-wiring`) — all re-pointed in
the 5.3 PR.

---

## §3 · Schema delta (one additive, human-gated migration)

> **🔄 Migration-mechanism note (2026-06-20):** `migrations-manual/P5_*.sql` is now **LEGACY** — the source
> record of the P5 dev-DB delta, now folded into the squashed baseline
> (`api/prisma/migrations/00000000000000_baseline/`). Schema below is unchanged; only the apply-mechanism
> moved (baseline + `migrate deploy` via the in-VPC job for staging/prod). Do not add to `migrations-manual/`.
> See [`../MIGRATIONS.md`](../MIGRATIONS.md).

`api/prisma/migrations-manual/P5_wallet_rewards_additive.sql` — guarded
`current_database()='gifsy_dev'`, idempotent, **additive only**:
- `OtpPurpose` **+`REDEMPTION_CONFIRM`** (matches spec WF4 + the unported platform routes).
- `reward_catalog` **+`stockQuantity` INTEGER** (nullable = untracked).
- `redemption_orders` **+`voucherCode` TEXT, +`voucherProvider` TEXT**.

**No new tables.** Pre-apply state verified read-only (2026-06-18): `gifsy_dev`; enum lacks
`REDEMPTION_CONFIRM` (orphan `prisma/migrations/20260606000002` never applied — that folder is not
the source of truth here); new columns absent; all four P5 tables empty (0 rows). → zero-risk additive.

**FREE_AMOUNT vouchers (not free via CRUD — flagged by independent review):** `RewardCatalog.pointsCost`
is NOT NULL and the ported `redeem` route hardcodes `pointsCost × qty`. Model: FIXED voucher =
`pointsCost` set, `redemptionMode=GIFT_CARD`; **FREE_AMOUNT** = `pointsCost=0` + `min/maxRedemptionPoints`
bound the range, and **5.4's redeem path takes a per-order ₹ amount × `conversionRate`, validated vs
min/max** (the variable-amount path the platform route never had). `conversionRate`/`minVoucherFreeAmount`
config relocates out of the demo settings surface in 5.3.

---

## §4 · Gaps & spec reconcile

- **#28 (PointsLedger inert) — closed by 5.2.** Write `PointsLedger` on **every** path
  (EARN/REDEEM/EXPIRE/ADJUST/REVERSE) — incl. the redeem debit, which today also skips the ledger.
- **#16 (POINTS never credit wallet) — primitive set up in 5.2, actual credit wiring is P6 6.2.**
- **`RewardInventory` phantom:** spec capabilities §10 lists it as a key entity; **no model exists**.
  Reconcile: inventory = `RewardCatalog.stockQuantity`; correct §10 (no separate entity).
- **`adjust()` latent bugs (independent review):** writes `WalletTransaction` but no `PointsLedger`,
  and **decrements `earnedPoints` on debit** (lifetime-earned must be monotonic). Fold into the 5.1/5.2
  ledger model or wallet⟷ledger silently desyncs.

---

## §5 · Build streams (operating model: plan → bg Sonnet executor [no shell] → independent audit → Opus gate → commit)

**Stream W — Wallet & Points** (`wallet/`, `PointsLedger`; schema-stable, can start before migration)
- **5.1** Harden `getWallet`/`listTransactions`/`adjust`; **fix `adjust`** (ledger write + stop
  `earnedPoints` decrement); lock the canonical invariant.
- **5.2** `PointsLedger` on all paths + `expiresAt` from `PointExpiryConfig` + expiry sweep
  (`DEBIT_EXPIRY`/ledger `EXPIRE`). Holding deferred (fields retained). **Closes #28.** ← 5.4 + P6 call this.

**Stream R — Rewards & Redemption** (`rewards/`, catalog, orders; **blocked on migration apply** for
`stockQuantity`/`voucherCode`)
- **5.3** Real catalog CRUD (`RewardCategory`/`RewardCatalog` + `stockQuantity`); retire blob +
  `lib/gifts.ts`; relocate voucher config; re-point 3 FE pages + 2 wiring tests.
- **5.4** Port `redeem` + `redeem/confirm` (OTP `REDEMPTION_CONFIRM`); variable-amount FREE_AMOUNT;
  **guarded status-transition** writing `RedemptionStatusHistory` + stamping timestamps;
  **refund-on-cancel/return** (re-credit via 5.2); **fulfilment** = inline per-order + bulk Excel
  download/upload; INR = debited order only (settlement → P6).

**FE — 5.5** (after W+R): partner wallet (drop localStorage), partner rewards (real redeem +
variable-amount + voucher-code copy + status timeline), admin catalog CRUD + fulfilment download/upload.

**Ordering:** 5.1→5.2 ∥ (5.3→5.4 after migration); 5.4 needs both 5.2 + 5.3; 5.5 last.

---

## §6 · Independent review (2026-06-18) — incorporated

An independent adversarial pass (Read/Grep, no shell) reviewed the plan. Agreed on the architecture;
sharpened: the enum value is `REDEMPTION_CONFIRM` not a new `REDEMPTION` (corrected); `adjust()`
ledger/`earnedPoints` bugs (§4); #28 scope includes the redeem debit (§4); FREE_AMOUNT needs a
variable-amount redeem path (§3); blob retirement breaks 3 FE pages + 2 tests + the voucher config
home (§2); `RewardInventory` phantom (§4); P6 should snapshot bank detail at payout-creation, not read
KYC live (§1); voucher code belongs on the order, not `PayoutTransaction` — which is what makes "only
INR defers to P6" true (§1). Its drift claim (schema vs the `20260606000002` migration) was
**superseded** by direct DB check: gifsy_dev never had that migration, so schema and DB agree.
