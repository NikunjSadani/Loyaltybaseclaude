# Client migration playbook — moving a client off a previous provider

**Status:** living guide (created 2026-11-21). Generic — for every future client that arrives with data from a
previous vendor. Worked example throughout: **Bajaj** (see `BAJAJ-DATA-MIGRATION.md` for the staging run and
`BAJAJ-PROD-OUTLET-IMPORT.md` §9b for the production points import).

Ground rules for every migration import:
- **Owner decisions first.** Every mapping / rounding / "keep or drop" question is listed in plain words with a
  recommendation and an alternative, and decided by the owner before anything is written.
- **Dry run → backup → apply → verify.** Every job is DRY RUN by default, guarded by `EXPECTED_DB` (+ an explicit
  `APPLY` + confirm string), and followed by a read-only verifier. Shared / prod DB writes only with the owner's go.
- **Reconcile exhaustively.** Source totals = imported + held + explained exclusions, per outlet and in total — the
  owner only spot-checks. Copy vendor documents into our own storage (vendor links expire).
- **Never drop silently.** Every row that is not imported is either *held* (below) or listed with its reason.

## Existing points programme: opening balances

When the client already runs a points programme with a vendor, each outlet's **closing balance** must arrive on our
platform exactly, together with an honest history.

### 1. Import closing = vendor closing, with a dated passbook
- The target per outlet is the **vendor's own closing balance on the cut-over day, rounded to whole points**
  (Bajaj: File 2 `ClosingPoints` at 11 Nov 2026 — the day the vendor stopped redemptions).
- The history is posted as a **dated passbook**, not one lump: monthly earns at the vendor file's own dates,
  redemptions per period, the yearly lapse (EXPIRE), adjustments (e.g. a pre-cut-over over-redemption recovered —
  ADJUST). Event shape: `{ d:'YYYY-MM-DD', t:'EARN'|'ADJUST'|'REDEEM'|'EXPIRE', p:<signed whole points>, l:<label> }`.
  Rounding: every event is rounded and the difference is put on the largest event, so Σ events == the target.
- Posting rules (identical in the bulk job and the held mechanism, `api/src/wallet/held-opening-balances/held-balance-events.ts`):
  order by date then EARN < ADJUST < REDEEM < EXPIRE; timestamps day + seq seconds; running balance from 0;
  FIFO `remainingPoints` on earn lots (Σ = max(closing, 0)), lots **non-expiring**; earned counters = Σ EARN,
  redeemed = Σ REDEEM, expired = Σ EXPIRE; ledger `sourceType = VENDOR_IMPORT`, `sourceId = <outlet>:tl:<seq>`.
  A history may dip below 0 mid-way (vendor sequencing); a negative closing (sales returns) is kept.
- Wallet Reversal Engine: if the tenant is (or will be) on **V2**, imported wallets must be sequenced — run the
  wallet backfill (`WALLET-REVERSAL-ENGINE-DESIGN.md` §9) after the bulk import; held balances sequence themselves.

### 2. Outlets not on the portal yet, or without a wallet → held opening balances (never dropped)
An outlet whose balance cannot be posted at import time (not enrolled yet, KYC not approved, no wallet) gets a
**held opening balance**: table `held_opening_balances` (one row per tenant × outlet × source) with the closing and
the full dated passbook, status `PENDING`. Owner-approved 2026-11-21 as a platform-wide mechanism, dormant for any
tenant without rows.
- **Automatic apply** — when the outlet's wallet is created (KYC approval, or a pre-KYC credit confirm that creates
  the wallet) and the wallet is still empty, the passbook is posted **in the same transaction**, verified
  (balance = closing, counters, row counts, FIFO lots) and the row becomes `APPLIED`. On a V2 tenant (or one whose
  wallets were already backfilled) the wallet is sequenced right away by the backfill's own planner
  (`backfillStatus = DONE`, so the V2 switch guard counts it). Any problem rolls back to a savepoint — nothing
  partial — and the row becomes `FAILED` with the reason; Gifsy admins get a bell. The KYC approval itself is never
  blocked.
- **Wallet already has activity** (e.g. approved before the rows were loaded) → the row stays `PENDING` and needs an
  explicit **Gifsy → Held Balances → Apply now** (GIFSY_ADMIN, audited, confirm dialog shows balance before → after).
  An empty wallet gets the full passbook; an active wallet gets ONE opening-balance adjustment of the closing
  (dated today; the vendor history stays on the held record). A negative closing larger than the wallet's balance
  is refused (resolve with the client). Two held rows for one owner (would pool into one wallet) → both `FAILED`.
- **Cancel** (audited, reason required) for a row that must never be posted (outlet closed, client instruction).
- **Loud reporting**: the Daily Ops Digest shows, for every tenant with rows,
  "Held opening balances: N applied today (pts), M still waiting (pts), K failed"; FAILED rows and rows waiting for
  an Apply now are attention items.
- **Loading rows** — job `dist/wallet/held-opening-balances/held-balances-load.main.js` (dry run by default):
  `EXPECTED_DB=<db> TENANT=<clientId> SOURCE=<e.g. vendor-earnburn-2026-11-11> MANIFEST=<path | gs://…>
  [EXPECTED_ROWS=n] [EXPECTED_TOTAL=pts]`; apply with `HELD_APPLY=true HELD_CONFIRM="APPLY <db>"`. Manifest =
  `[{ outletCode, closingPoints, events }]`. Any invalid passbook refuses the whole load; an outlet whose wallet
  already carries a vendor passbook is refused (would double); re-runs are idempotent. The plan lists every row:
  INSERT · INSERT_APPLY_NOW · ALREADY_LOADED · REFUSED_IMPORTED · INVALID.

### 3. Reconciliation table (fill in for every migration)

| Line | Outlets | Points | Source / evidence |
|---|---:|---:|---|
| Vendor total closing (cut-over day) | all rows | A | vendor file, sum of closing column |
| Imported into wallets (rounded per outlet) | n₁ | B | bulk import job + verifier |
| Held opening balances (vendor raw) | n₂ | C | held manifest / `held_opening_balances` |
| Zero-balance outlets (nothing to carry) | n₃ | 0 | listed |
| Explicitly excluded (owner decision, listed) | n₄ | D | decision log |
| Rounding (imported rounded − imported raw) | — | R | builder output |
| **Check** | | **A = B + C + D − R** | must hold to the paisa |

### 4. Verification steps
1. Builder prints its totals; they match the vendor file's own totals (and its internal checks: per-period burn
   splits = totals, carry + earn − burn = closing).
2. Loader DRY RUN on the target DB: counts per action, Σ closing = EXPECTED_TOTAL, 0 INVALID, 0 REFUSED_IMPORTED.
3. Backup, then APPLY; re-run the dry run → every row ALREADY_LOADED.
4. After each KYC approval wave: Gifsy → Held Balances shows the rows APPLIED with the wallet; the outlet's passbook
   shows the dated history; wallet balance = the row's points. The digest line moves from "waiting" to "applied".
5. Rows still waiting with an active wallet → Apply now; FAILED rows → read the reason, fix, Apply now (or Cancel).
6. V2 tenants: no applied wallet stays un-sequenced (`movementSeq = 0` with history) — the V2 switch guard confirms.

### 5. Bajaj example (vendor 11 Nov 2026 closing)

| Line | Outlets | Points |
|---|---:|---:|
| Vendor total (File 2 `ClosingPoints`) | 2,786 | **68,50,556.46** |
| Imported into wallets 2026-11-12 (rounded per outlet; raw 67,27,710.99) | 2,281 | 67,27,723 |
| Held opening balances (vendor raw) | 40 | 1,22,845.47 |
| Zero-balance outlets | 465 | 0 |
| Rounding of the imported wallets | — | 12.01 |
| **Check:** 67,27,723 + 1,22,845.47 − 12.01 | | **68,50,556.46** ✓ |

The 40 held rows round per outlet to **1,22,843 pts** (rounding 2.47; 28 outlets with File 1 history, 12 with only
the FY26-27 report — carry-forward + monthly earn/burn; 348 events; 1 history dips below 0 mid-way; no negative
closing). Builder: `api/scripts/bajaj-held-opening-balances-manifest.mjs` (args: File 1, File 2, the 2,281 import
manifest, output path; `--expect-outlets 40`). Load: `TENANT=bajaj SOURCE=vendor-earnburn-2026-11-11
EXPECTED_ROWS=40 EXPECTED_TOTAL=122843`. **Not loaded yet** — needs the owner's go (prod write).

⚠️ **Open owner decision (Bajaj):** 293 outlets of vendor File 1 (history to 31 Oct 2026) that are not on prod carry
a File-1 closing (Σ 2,22,995.55 pts) but do **not appear in File 2** (the vendor's 11-Nov report), so there is no
11-Nov closing to honour; they are not held. 17 more appear in File 2 with a 0 closing (the vendor's later figure
wins). Generic lesson: always reconcile EVERY vendor file against the target file, not just the target file.
