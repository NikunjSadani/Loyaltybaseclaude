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
- Wallet Reversal Engine (one engine for every tenant since 2026-11-21): bulk-imported wallets must be sequenced —
  run the wallet backfill (`WALLET-REVERSAL-ENGINE-DESIGN.md` §9) after the bulk import (until then they show in the
  reversal-readiness count and POINTS reversals on them are refused); held balances sequence themselves.

### 2. Outlets not on the portal yet, or without a wallet → held opening balances (never dropped)
An outlet whose balance cannot be posted at import time (not enrolled yet, KYC not approved, no wallet) gets a
**held opening balance**: table `held_opening_balances` with the closing, the full dated passbook and the closing's
as-of date, status `PENDING`. Owner-approved 2026-11-21 as a platform-wide mechanism, dormant for any tenant without
rows. Outlet codes are normalised on both sides (trim, upper-case, no internal spaces — leading zeros kept); an
exact-code non-match shows as "Not on portal". The **database allows ONE live (PENDING / FAILED / APPLIED) row per
outlet** — a reload or a double Apply now can never post twice.
- **Automatic apply — never inside the business transaction.** Each row is applied in its OWN transaction:
  right after a KYC approval commits; BEFORE a credit confirm lands on the outlet (the wallet is created first if
  needed, so the dated history always sits under the new credit — history is never back-dated under credits that
  already landed); and by a sweep every ~10 minutes (any PENDING row whose wallet exists and is empty). The wallet
  must still be empty; the passbook is posted, verified (balance = closing, counters, row counts, FIFO lots) and the
  wallet is **sequenced for the V2 engine** by the backfill's own planner (`backfillStatus = DONE`). Any problem rolls
  the whole transaction back — nothing partial. A deterministic problem (passbook doesn't tie out, sequencing
  BLOCKED, two rows would pool into one wallet, the wallet already received a held balance, any non-connectivity
  error) → `FAILED` at once with the reason + a bell to Gifsy admins; only a temporary DB error (connection / timeout /
  serialization / lock) stays `PENDING` with the error shown, retried by the sweep, `FAILED` after 5 attempts. A KYC
  approval is never failed or slowed by it. A **credit confirm is REFUSED** (409, nothing credited, batch still
  waiting) while a target outlet's held balance is not posted onto its empty wallet — a credit never lands over a
  not-yet-posted passbook; the message names the outlets. The sweep pages through every waiting row whose outlet has
  a wallet (rows waiting for KYC cannot starve it).
- **Every waiting row has an explicit state** (console + digest): Not on portal (no outlet with this code) · On
  portal — awaiting first KYC · Wallet exists and empty — will apply now / applying · Wallet has activity — needs
  Apply now · Wallet not prepared — run the wallet backfill, then Apply now (amber: history the backfill has not
  sequenced; nothing is written) · Failed — <reason>.
- **Wallet already has activity** → explicit **Gifsy → Held Balances → Apply now** (GIFSY_ADMIN, audited, confirm
  dialog shows balance before → after): ONE opening-balance adjustment of the closing, shown to the retailer as
  "Opening balance from previous programme (as of <date>)" (the dated vendor history stays on the held record). The
  wallet must already be sequenced (else the row stays PENDING "Wallet not prepared"); a negative closing larger than
  the wallet's balance is refused.
- **Cancel** (audited, reason required) for a row that must never be posted (outlet closed, client instruction).
- **Loud reporting**: the Daily Ops Digest shows, for every tenant with rows, "Held opening balances: N applied since
  the last report (<window> IST) (pts), M still waiting (pts) [by state], K failed"; FAILED rows, rows needing Apply
  now and ambiguous outlet codes are attention items.
- **Loading rows** — job `dist/wallet/held-opening-balances/held-balances-load.main.js` (dry run by default):
  `EXPECTED_DB=<db> TENANT=<clientId> SOURCE=<e.g. vendor-earnburn-2026-11-11> MANIFEST=<path | gs://…>`; APPLY
  needs `HELD_APPLY=true HELD_CONFIRM="APPLY <db>" EXPECTED_ROWS=n EXPECTED_TOTAL=pts AS_OF=YYYY-MM-DD` (the totals are
  checked against the closings AND, independently, Σ of the event deltas). Manifest = `[{ outletCode, closingPoints,
  events }]`. The plan lists every row: INSERT · INSERT_APPLY_NOW · SUPERSEDE · ALREADY_LOADED · REFUSED_EXISTING ·
  REFUSED_IMPORTED · INVALID; any refused / invalid row refuses the whole load. A second row for an outlet that
  already has a live held row is refused unless `SUPERSEDE=true` (cancels the old PENDING / FAILED row in the same
  transaction; an APPLIED row is never superseded). An outlet whose wallet already carries a vendor balance
  (`:tl:` / `:held-open:` / bulk `:opening-*` lots) is refused.

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
| Held rounding (held raw → posted, rounded per outlet) | n₂ | C → C' | builder output |
| Not carried: other vendor files' balances absent from the target file (owner decision, listed) | n₅ | E | builder `.excluded.json` |

### 4. Verification steps
1. Builder prints its totals; they match the vendor file's own totals (and its internal checks: per-period burn
   splits = totals, carry + earn − burn = closing).
2. Loader DRY RUN on the target DB: counts per action, Σ closing = EXPECTED_TOTAL, 0 INVALID, 0 REFUSED_IMPORTED.
3. Backup, then APPLY; re-run the dry run → every row ALREADY_LOADED.
4. After each KYC approval wave: Gifsy → Held Balances shows the rows APPLIED with the wallet; the outlet's passbook
   shows the dated history; wallet balance = the row's points. The digest line moves from "waiting" to "applied".
5. Rows still waiting with an active wallet → Apply now; FAILED rows → read the reason, fix, Apply now (or Cancel).
6. No applied wallet stays un-sequenced (`movementSeq = 0` with history) — the readiness line on the credits screen
   (and the Daily Ops Digest) shows 0 wallets "not yet prepared for reversals".

### 5. Bajaj example (vendor 11 Nov 2026 closing)

| Line | Outlets | Points |
|---|---:|---:|
| Vendor total (File 2 `ClosingPoints`) | 2,786 | **68,50,556.46** |
| Imported into wallets 2026-11-12 (rounded per outlet; raw 67,27,710.99) | 2,281 | 67,27,723 |
| Held opening balances (vendor raw) | 40 | 1,22,845.47 |
| Zero-balance outlets | 465 | 0 |
| Rounding of the imported wallets | — | 12.01 |
| **Check:** 67,27,723 + 1,22,845.47 − 12.01 | | **68,50,556.46** ✓ |
| Held rounding: raw 1,22,845.47 → posted (rounded per outlet) | 40 | 1,22,843 (−2.47) |
| Not carried — File-1 outlets absent from the 11-Nov report (owner decision 2026-11-21: the 11-Nov report is final) | 293 | 2,22,995.55 |
| Not carried — File-1 balance but 11-Nov closing 0 (the vendor's later figure wins) | 17 | 0 |

The 40 held rows round per outlet to **1,22,843 pts** (rounding 2.47; 28 outlets with File 1 history, 12 with only
the FY26-27 report — carry-forward + monthly earn/burn; 348 events; 1 history dips below 0 mid-way; no negative
closing). Builder: `api/scripts/bajaj-held-opening-balances-manifest.mjs` (args: File 1, File 2, the 2,281 import
manifest, output path; `--expect-outlets 40`). Load: `TENANT=bajaj SOURCE=vendor-earnburn-2026-11-11
EXPECTED_ROWS=40 EXPECTED_TOTAL=122843 AS_OF=2026-11-11`. **Not loaded yet** — needs the owner's go (prod write).

Prod load steps (exact commands, required order): `BAJAJ-PROD-FOLLOWUPS-RUNBOOK.md` §D.

**Owner decision 2026-11-21 (Bajaj):** the 293 File-1 outlets not on prod whose File-1 closing (Σ 2,22,995.55 pts)
has no line in File 2 (the vendor's 11-Nov report) are **IGNORED — the 11-Nov report is final**; the builder prints,
counts and lists them (`<out>.excluded.json`) as "excluded — owner decision 2026-11-21". Generic lesson: always
reconcile EVERY vendor file against the target file, and record each exclusion as an owner decision.
