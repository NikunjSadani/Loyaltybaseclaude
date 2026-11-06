# Wallet statement: Excel/PDF picker + running Balance column

> ## ⚠️ PLATFORM-WIDE: needs owner approval before ANY task is built
> This touches **shared** code that every tenant runs, including the **LIVE Deoleo** program and Bajaj (staging):
> the partner wallet page (`/partner/wallet`), the sales outlet ledger (`/sales/kyc/[id]/ledger`), a **new shared
> backend endpoint** (`GET /v1/wallet/statement`), and a change to an existing shared endpoint (`GET /v1/kyc/:id/ledger`).
> It can't be done per tenant: the wallet page, the ledger page and the passbook service are single shared code paths,
> and the fixes below (missing Balance, broken `--50` sign, 20-row truncation) are defects in that shared code.
> There's no per-tenant config to hang this on, and adding a flag just to hide a correctness fix would be YAGNI.
> **Status: BUILT + independently reviewed (2026-11-06) on branch `worktree-agent-aa3654f9fde6b0c8a`, NOT pushed.
> D9 final (owner, 2026-11-06): KEEP the interim PDF text — "Rs." for ₹ and names in English letters only (see §D9
> FINDING). Approved as PLATFORM-WIDE by the owner; §OWNER DECISIONS (final) override anything below where they differ.**
> Task 0 (staging DB chain audit) still to be run before the push. No schema change, no migration, no new npm
> dependency, no font asset.

---

## 0. Read this first (zero-context primer)

**The product.** Loyaltybase is a multi-tenant trade-loyalty platform. **Partners** (retail outlet owners) earn points,
which get credited in uploads, expire on a schedule, or are redeemed for gifts or vouchers. Every movement is a row in
the partner's **passbook**. The partner sees the passbook on `/partner/wallet` as the "Statement" and can download it.
**Sales reps** see the same outlet's passbook on `/sales/kyc/[id]/ledger`, a page the tile labels with the tenant's
`salesApp.ledgerLabel` (e.g. "Wallet"). Each tenant (brand) such as Deoleo or Bajaj shares this code.

**Architecture.** `api/` (NestJS + Prisma) owns the DB and all business logic. `platform/` (Next.js) is a thin
frontend. A browser call to `/api/foo` is rewritten to the backend `/v1/foo` (`platform/next.config.ts` →
`rewrites()`). `platform/src/proxy.ts` injects the auth bearer and the `x-active-partner-id` header (multi-outlet
owners), so FE code calls `fetch('/api/…')` with `authHeader()`, which is now an empty object. That's expected.
⚠️ This Next.js version differs from your training data. Before touching a page, skim
`platform/node_modules/next/dist/docs/` (both pages here are `'use client'` components, so you mostly won't need it).

**What exists today (verified 2026-11-06):**

| Surface | How it downloads | Library | Balance column? | Data limit |
|---|---|---|---|---|
| Partner wallet `platform/src/app/partner/wallet/page.tsx`, `downloadCombinedStatement()` (~L136), button `data-testid="excel-btn"` (~L401) | **client-side** SheetJS `XLSX.writeFile` | `xlsx` | **NO**. Columns: Date, Description, Type, Points, Amount (₹), UTR | ⚠️ fetches `/api/wallet/transactions` with **no params**, so the backend returns **page 1 of 20 rows** (`ListTransactionsQueryDto` default `limit=20`). The on-screen statement **and** the Excel cover only the newest 20 points rows. |
| Sales outlet ledger `platform/src/app/sales/kyc/[id]/ledger/page.tsx`, `downloadLedger()` (~L127) | client-side SheetJS | `xlsx` | **Yes** (`entry.balance` = stored `balanceAfter`) | backend `kyc.service.ledger()` (~L3597) uses `take: 200` newest, so it's truncated for big outlets |
| Admin Points-Ledger report `admin/reports/points-ledger`, `GET /v1/admin/reports/points-ledger?format=xlsx` | **backend** `buildXlsx` (`api/src/common/xlsx.ts`) | `xlsx` | Opening + closing per outlet (monthly aggregate, not a passbook) | n/a. Not a statement, **out of scope** |
| Admin outlet-wallet (GIFSY) `admin/outlet-wallet/page.tsx` | **no download** | n/a | on-screen only | paginated. **Out of scope** |

**Two existing bugs this plan fixes along the way (both in the partner Excel):**
1. **No Balance column.** This is the owner's ask. The on-screen row already shows "Bal N" (`components/wallet/transaction-item.tsx` ~L79).
2. **Double-minus sign.** Backend `WalletTransaction.points` is **signed** (debits negative, see
   `applyMovement` in `api/src/wallet/wallet.service.ts`). The Excel does `` `-${tx.amount}` ``, so a 50-pt redemption
   exports as **`--50`**. The on-screen row was already fixed for this (transaction-item.tsx ~L73 comment); the Excel was not.

**Libraries already installed (reuse; don't add):**
- `xlsx` ^0.18.5 in **both** `api/package.json` and `platform/package.json`. FE wrapper: `platform/src/lib/xlsx-safe.ts`
  (`jsonToSheetSafe`, `aoaToSheetSafe`, which neutralise CSV/formula injection; **always** use them, never raw `XLSX.utils.json_to_sheet`).
- `jspdf` ^4.2.1 in **platform only**. Two in-house examples: `platform/src/lib/so-declaration.ts`
  (`renderSoDeclarationPdf` returns a **Blob**, has the `ensureSpace` page-break pattern, so copy this shape) and
  `platform/src/components/invoice/VisibilityInvoicePDF.ts`, which writes money as **`Rs.`** because jsPDF's built-in
  Helvetica has no `₹` glyph (and no Devanagari).
- **No PDF library in `api/`.** Backend PDF would need a new dependency (`pdfkit`, the lightest), which is **owner decision D6**.
- Save-to-disk helper: `platform/src/lib/download.ts` → `downloadBlob(blob, filename)`. Use it; it handles the
  attach-before-click / deferred-revoke traps.

**Domain rules you must not get wrong (the running balance):**
- **`WalletTransaction`** (`api/prisma/schema.prisma` ~L1446) = the passbook row: `points` (signed), `balanceBefore`,
  `balanceAfter`, `transactionType`, `createdAt`, `description`, `referenceType/referenceId`. Every write goes through
  ONE primitive, `WalletService.applyMovement`, which updates `Wallet.redeemablePoints` and writes `balanceBefore/After`
  **in the same DB transaction**. So the stored `balanceAfter` is the authoritative balance snapshot after each row.
- **`PointsLedger`** = the lot table (for FIFO expiry, `remainingPoints`). **Don't** build the statement from it. It's
  the lot mirror, not the passbook, and it doesn't carry `balanceAfter`.
- **Never recompute the balance as Σ signed points.** It doesn't always tie out:
  - **Clawback shortfall** (`clawbackAward`): records `points = -500` but only decrements `min(500, balance)`, so the
    row says −500 while the balance drops by 300 (the description carries `[SHORTFALL: …]`).
  - **Pre-FIFO-fix expiry rows** (before 2026-11-04 `524acda`) floored at 0 the same way.
  - The admin Points-Ledger report **does** use Σ signed points (with a documented caveat), and it had a **sign bug**
    (summed signed `points` wrong and overstated redeemed outlets, e.g. Chakradhar 20,516 vs a report value of 91,516). It was fixed in
    `api/src/admin-programs/reports/report-helpers.ts` `aggregateLedgerToRow` (~L90). Read that function as a cautionary example.
  - ⇒ **Balance column = the stored `balanceAfter`.** Opening balance = `balanceBefore` of the first in-range row. See D3.
- **LOCK_HOLDING / UNLOCK_HOLDING** rows move the (dormant, always-0) locked bucket, not the redeemable balance.
  The partner statement already excludes them (`isMainEntry`). The statement excludes them too.
- **Ordering.** Sort chronologically by `createdAt` ASC, then `id` ASC. **Same-timestamp trap:** several rows written in ONE
  DB transaction can share `createdAt` (Postgres `CURRENT_TIMESTAMP` is the transaction start time). The Bajaj import
  deliberately wrote "distinct same-day timestamps" for this reason (`BAJAJ-DATA-MIGRATION.md` §0). Within a tie group,
  order rows so each row's `balanceBefore` equals the previous row's `balanceAfter` (chain order), with `id` as the fallback.
- **Tie-out.** For a range that runs to "now" (or no range), the closing balance (last row's `balanceAfter`) **must
  equal** `Wallet.redeemablePoints`, which is what the balance card shows. If it doesn't, log a server `warn`
  (walletId, both numbers) and still return the stored values (D10).
- **Wallet row exists only after KYC approval** (RESUME trap 3). No wallet means an empty statement (not a 404).
- **IST dates.** Prod runs UTC, but every displayed date and month boundary is **IST**. Backend: `api/src/common/ist-date.ts`
  (`istMonthBounds('YYYY-MM') → {start, endExclusive}`, which you use with `gte`/`lt`, plus `istDateKey`, `istDateTimeCell`). FE:
  `platform/src/lib/ist-date.ts` (`formatISTDate`, `istDateKey`, `istMonthKey`). **Never** `getMonth()`/`toISOString().slice`
  for a displayed or bucketed date. (The partner page's `toMonthKey` uses local `getMonth()`. Leave the on-screen
  filter alone, but don't copy it.)
- **Credit "field name".** Credit-batch rows show the KPI/field name (e.g. "Visibility") resolved by
  `resolveCreditFieldNames` (`api/src/common/credit-field-name.helper.ts`). It must be resolved over **all** of the
  wallet's CREDIT_BATCH rows (not just the window), exactly as `loadPassbook` does (wallet.service ~L423–451).
- **Payout (₹) rows.** Both pages interleave ₹ payout entries (from `buildPayoutStatement`,
  `api/src/common/payout-statement.helper.ts`) with points rows. Payout rows carry **no** points and **no** Balance
  (balance is points-only). That's existing behaviour, so keep it (D8).
- **Tenant ids vs codes** (RESUME traps a/6): the FE `outletId` = Outlet CUID; `CreditPayoutEntry.outletId` = outlet CODE.
  You won't need either directly. The statement is keyed by the caller's active partner (wallet route) or the KYC submission id (sales route).

**Scale you must design for.** Bajaj staging: **29,438 imported ledger events across 2,317 outlets** (~13 per outlet
on average, some far more). Deoleo: monthly credit uploads plus expiry and redemption rows. A single wallet can reach low
thousands of rows over years. Every builder must handle **5,000 rows** quickly (test it), and the backend must not
paginate the statement (that's the bug we're fixing). Cap the rows instead (`MAX_STATEMENT_ROWS = 20_000`, which returns 400 "narrow the date range").

**Tests.**
- Backend: **Jest**. One file: `cd api && npx jest src/common/points-statement.helper.spec.ts --no-coverage`.
  Service spec style is in `api/src/wallet/wallet.service.spec.ts` (hand-rolled `mockPrisma` with `jest.fn()`s, see
  `describe('listTransactions')` ~L441) and the KYC ledger tests (`grep -n "ledger" api/src/kyc/*.spec.ts`).
- Frontend: **Vitest** + React Testing Library, jsdom. One file:
  `cd platform && npx vitest run src/lib/wallet-statement/__tests__/statement-model.test.ts`.
  Page-test mocking setup: copy from `platform/src/app/partner/wallet/__tests__/wallet-api.test.tsx` (mocks `fetch`
  by URL) and `statement-layout.test.tsx`. Sales: `platform/src/app/sales/kyc/[id]/ledger/__tests__/payout-rows.test.tsx`.
- Full gate (before the last commit only): `bash scripts/gates.sh` from the repo root. Read its exit code / the
  `GATES: ✅` line. **Never** trust a piped exit code (`npx nest build | tail` always exits 0).

**Good test design here (please follow).**
- **Pure functions first.** All balance and ordering logic lives in pure functions (no Prisma, no React) with dense,
  table-style tests. Services and components get a few thin tests that prove the wiring.
- Name each `it(...)` as a sentence of the rule: `it('opening balance is the first in-range row's balanceBefore')`.
- One behaviour per test. Build fixtures with a tiny factory (`row({ points: -50, before: 100, after: 50 })`) so each
  test shows only what matters.
- **Always include the edge case that motivated the rule**: clawback shortfall (points −500, balance −300), a
  same-timestamp pair inserted out of chain order, an empty range after earlier activity (opening = closing = prior balance).
- Write the test FIRST, run it, and **watch it fail for the right reason** (missing export or wrong value, not a typo),
  then implement.
- For renderers, assert on **what the user gets** (read the generated xlsx back with `XLSX.read`; check the PDF's page
  count and the text it contains), not on internal calls.

**Principles.** DRY: ONE backend window builder used by both endpoints, ONE FE statement model, and ONE pair of
renderers used by both pages. YAGNI: no new deps, no settings or flags, no admin download, no email-a-statement.
TDD. **One task = one commit**, each with the commit footer required by `CLAUDE.md`/the session attribution.
Work on branch `develop` (CLAUDE.md). **Don't push.** The orchestrator reviews, gates and pushes with the owner's OK.

---

## File landmarks (search for the quoted text; line numbers approximate)

| What | Where |
|---|---|
| Wallet write primitive (sign + balanceBefore/After) | `api/src/wallet/wallet.service.ts`, `private async applyMovement(` (~L64) |
| Clawback shortfall (why Σpoints ≠ balance) | same file, `async clawbackAward(` (~L833) |
| Expiry sweep (FIFO, clamp) | same file, `async expireDuePoints(` (~L897) |
| Paginated passbook (field-name resolution to copy) | same file, `private async loadPassbook(` (~L386) |
| Partner active-partner resolution | same file, `async listTransactions(` (~L482) → `resolveActivePartnerId` |
| Wallet routes | `api/src/wallet/wallet.controller.ts`, `@Get('transactions')` (~L47) |
| Wallet DTOs | `api/src/wallet/dto/wallet.dto.ts`, `ListTransactionsQueryDto` |
| Sales ledger backend | `api/src/kyc/kyc.service.ts`, `async ledger(` (~L3597), `take: 200`; `function mapTxType(` (~L5573) |
| Sales ledger route | `api/src/kyc/kyc.controller.ts`, `@Get(':id/ledger')` (~L313) |
| Shared payout builder (pattern to mirror) | `api/src/common/payout-statement.helper.ts`, `buildPayoutStatement` |
| IST helpers | `api/src/common/ist-date.ts`, `platform/src/lib/ist-date.ts` |
| Report sign-bug fix (read, don't touch) | `api/src/admin-programs/reports/report-helpers.ts`, `aggregateLedgerToRow` |
| Partner page export + fetch | `platform/src/app/partner/wallet/page.tsx`, `function downloadCombinedStatement(`, `fetch('/api/wallet/transactions'`, `data-testid="excel-btn"` |
| Sales page export + fetch | `platform/src/app/sales/kyc/[id]/ledger/page.tsx`, `function downloadLedger(`, `fetch(\`/api/kyc/${id}/ledger\`)` |
| Row renderers (unchanged) | `platform/src/components/wallet/transaction-item.tsx`, `payout-statement-row.tsx` |
| xlsx safety wrapper | `platform/src/lib/xlsx-safe.ts` |
| jsPDF pattern | `platform/src/lib/so-declaration.ts`, `renderSoDeclarationPdf` |
| Blob download | `platform/src/lib/download.ts`, `downloadBlob` |
| Tenant label | `platform/src/lib/gifsy-settings.ts`, `salesApp.ledgerLabel` (tile label only) |

New files this plan creates:
- `api/src/common/points-statement.helper.ts` (+ `.spec.ts`)
- `platform/src/lib/wallet-statement/statement-model.ts`, `statement-xlsx.ts`, `statement-pdf.ts` (+ `__tests__/`)
- `platform/src/components/wallet/statement-download-button.tsx` (+ test)

---

## Task 0: Data audit (orchestrator/owner; read-only; NO commit)

The recommended design trusts the stored `balanceBefore/balanceAfter` chain. Prove it holds on real data **before**
building. Staging and prod share a private-IP DB, so this is a **guarded DB op that needs the owner**: run it via the
`gifsy-oneoff-staging` Cloud Run Job (RESUME trap 16) with a `SELECT current_database()` guard asserting `gifsy_staging`.
Read-only SQL, run per tenant (Deoleo, Bajaj):

```sql
-- (a) tail ties out: last main row's balanceAfter == wallet.redeemablePoints
WITH last AS (
  SELECT DISTINCT ON (wt."walletId") wt."walletId", wt."balanceAfter"
  FROM wallet_transactions wt
  WHERE wt."transactionType" NOT IN ('LOCK_HOLDING','UNLOCK_HOLDING')
  ORDER BY wt."walletId", wt."createdAt" DESC, wt.id DESC)
SELECT count(*) AS mismatches FROM last JOIN wallets w ON w.id = last."walletId"
WHERE last."balanceAfter" <> w."redeemablePoints";
-- (b) chain breaks: a row whose balanceBefore != previous row's balanceAfter
SELECT count(*) AS breaks FROM (
  SELECT "balanceBefore", lag("balanceAfter") OVER (PARTITION BY "walletId" ORDER BY "createdAt", id) AS prev
  FROM wallet_transactions WHERE "transactionType" NOT IN ('LOCK_HOLDING','UNLOCK_HOLDING')) x
WHERE prev IS NOT NULL AND "balanceBefore" <> prev;
-- (c) same-timestamp groups (how often the tie-break matters)
SELECT count(*) FROM (SELECT "walletId","createdAt" FROM wallet_transactions
  GROUP BY 1,2 HAVING count(*) > 1) g;
-- (d) biggest wallets (sizes the PDF/perf tests)
SELECT max(c), percentile_cont(0.99) WITHIN GROUP (ORDER BY c) FROM
  (SELECT count(*) c FROM wallet_transactions GROUP BY "walletId") s;
```
(Add a `JOIN wallets → channel_partners` with a `"clientId"` filter per tenant.)
**Expected:** (a) 0, (b) ~0 (any non-zero ⇒ list the walletIds, since (c) id-order ties can produce false breaks that
chain-ordering fixes). **If (a) or (b) is materially non-zero, STOP and go back to the owner**. D3 may flip.

---

## Task 1: Pure statement-window helper (backend)

**Files:** new `api/src/common/points-statement.helper.ts`, new `api/src/common/points-statement.helper.spec.ts`.

**Shape:**
```ts
export interface StatementTx {            // a WalletTransaction projection
  id: string; createdAt: Date; transactionType: string;
  points: number; balanceBefore: number; balanceAfter: number;
  description: string | null; referenceType: string | null; referenceId: string | null;
}
export function orderStatementRows(rows: StatementTx[]): StatementTx[];          // asc + chain tie-break, drops LOCK/UNLOCK
export function buildStatementWindow(
  ordered: StatementTx[],                  // already ordered, may include rows before the window
  window: { start?: Date; endExclusive?: Date },
): { openingBalance: number; closingBalance: number; rows: StatementTx[] };
```

1. **Tests first** (`describe('orderStatementRows')`, `describe('buildStatementWindow')`). Use a factory
   `tx({ id, at, type, points, before, after })`.
   - sorts by `createdAt` ASC regardless of input order.
   - drops `LOCK_HOLDING` and `UNLOCK_HOLDING`.
   - **same-timestamp:** two rows with an identical `createdAt` given as `[B(before 150, after 100), A(before 100, after 150)]`,
     where the row before them ended at 100 → output `A, B` (chain order), even though `B.id < A.id`.
   - same-timestamp with **no** chain match (corrupt data) → falls back to `id` ASC and doesn't throw or drop rows.
   - no window → opening `0`, closing = last `balanceAfter`, all rows.
   - **opening for a date-filtered range** = first in-range row's `balanceBefore` (e.g. history 100 → 250 → 200, window
     covering only the 3rd row → opening 250, closing 200, rows length 1).
   - window **after** all activity (empty range) → `rows: []`, opening = closing = last prior `balanceAfter`.
   - window **before** all activity → `rows: []`, opening = closing = `0`.
   - **debit row**: `points -50, before 200, after 150` → row kept as-is (signed), closing 150.
   - **expiry row** (`DEBIT_EXPIRY`, `points -20`) and **reversal row** (`CREDIT_REVERSAL`, `points +80`) carry their stored balances.
   - **clawback shortfall**: `DEBIT_ADJUSTMENT points -500, before 300, after 0` → closing `0` (NOT `-200`). This test
     guards the "never Σ points" rule.
   - window boundaries are `start <= createdAt < endExclusive` (a row at exactly `endExclusive` is excluded).
   - **scale**: 5,000 generated rows (alternating credit/debit with a consistent chain), shuffled → ordered correctly
     and the closing equals the final `balanceAfter`; finishes in < 200 ms (`performance.now()`).
2. Run `cd api && npx jest src/common/points-statement.helper.spec.ts --no-coverage` → fails (module missing).
3. Implement. Group by `createdAt.getTime()`. Within a group, repeatedly pick the row whose `balanceBefore` equals the
   running balance (ties → lowest `id`), else the lowest `id`. Keep it O(n log n) overall (groups are tiny).
   Pure, so no Prisma imports.
4. Green → commit `feat(wallet): pure statement window + chain ordering helper (platform-wide)`.

## Task 2: DB loader `loadPointsStatement` (backend)

**Files:** same helper file + spec.

```ts
export const MAX_STATEMENT_ROWS = 20_000;
export async function loadPointsStatement(
  prisma: Pick<PrismaService, 'walletTransaction' | …>, args: {
    walletId: string; clientId: string; outletCode: string;
    from?: string; to?: string;            // 'YYYY-MM' (IST months), both or neither
}): Promise<{ openingBalance; closingBalance; rows: Array<StatementTx & { fieldName: string | null }> }>
```
1. **Tests first** (mock prisma like `wallet.service.spec.ts`):
   - queries `walletTransaction.findMany` with `where: { walletId, transactionType: { notIn: ['LOCK_HOLDING','UNLOCK_HOLDING'] } }`,
     `orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]` and **no `take`/`skip`** (asserts the 20-row bug can't recur).
   - with `from='2026-04', to='2026-06'`, the window bounds are `istMonthBounds('2026-04').start` and
     `istMonthBounds('2026-06').endExclusive` (assert the exact UTC instants: `2026-03-31T18:30:00.000Z` and `2026-06-30T18:30:00.000Z`).
   - a row at `2026-03-31T18:29:59Z` (still **31 Mar IST**) is excluded and becomes part of the opening; a row at `2026-03-31T18:30:00Z` (1 Apr IST) is included.
   - `fieldName` is attached from `resolveCreditFieldNames` (mock it with `jest.mock('./credit-field-name.helper')`) and
     resolution receives **all** CREDIT_BATCH rows, not only the windowed ones.
   - more than `MAX_STATEMENT_ROWS` rows in the window → throws `BadRequestException` whose message mentions narrowing the date range.
   - only one of `from`/`to`, a malformed month, or `from > to` → `BadRequestException`.
2. Run → fail. 3. Implement: load all main rows for the wallet (one query; it's per-wallet and indexed on `walletId`), then
   `orderStatementRows` → `buildStatementWindow` → cap check → attach `fieldName`.
   (Loading all rows rather than a windowed query keeps the same-timestamp chain logic correct at the window edge. A wallet
   is at most low thousands of rows, so this is cheap. Don't optimise.)
4. Green → commit `feat(wallet): loadPointsStatement shared loader (platform-wide)`.

## Task 3: `GET /v1/wallet/statement` (partner)

**Files:** `api/src/wallet/wallet.controller.ts`, `wallet.service.ts`, `dto/wallet.dto.ts`, `wallet.controller.spec.ts`, `wallet.service.spec.ts`.

1. **Tests first:**
   - controller: `@Get('statement')` has the same guards as `transactions`: `@Roles('SSS','WHOLESALER','SUB_STOCKIST')`,
     `@RequirePermission('wallet:read')`, and passes the `x-active-partner-id` header through (copy the existing controller spec pattern).
   - service `statement(user, {from,to}, activePartnerId)`:
     - foreign `x-active-partner-id` → `ForbiddenException` (reuse `resolveActivePartnerId`, as `listTransactions` does).
     - no partner or **no wallet (pre-KYC)** → `{ openingBalance: 0, closingBalance: 0, currentBalance: 0, rows: [] }`.
     - returns `currentBalance = wallet.redeemablePoints` alongside the loader output; row shape = `{ id, date (ISO),
       transactionType, description (with getDefaultDescription fallback), narration (raw), fieldName, points, balanceAfter }`.
     - **tie-out:** no range, and the closing ≠ `redeemablePoints` → `Logger.warn` is called with the walletId and both
       numbers, and the response still returns the stored values.
   - DTO `StatementQueryDto`: `from`/`to` optional, `@Matches(/^\d{4}-(0[1-9]|1[0-2])$/)`.
2. Run → fail. 3. Implement (resolve the primary outlet code the way `loadPassbook` does).
4. Green → commit `feat(wallet): GET /v1/wallet/statement — full, unpaginated statement with balances (platform-wide)`.

## Task 4: Sales ledger uses the shared loader (removes the 200-row cap) + range route

**Files:** `api/src/kyc/kyc.service.ts`, `kyc.controller.ts`, the matching KYC ledger spec(s) (`grep -ln "ledger" api/src/kyc/*.spec.ts`).

1. **Tests first:**
   - `ledger()` returns **all** points rows (seed 250 rows, expect 250; this fails today at 200), still newest-first in
     the existing `{date (IST key), description, type, points, balance, ref, fieldName}` shape (no FE contract change).
   - new `ledgerStatement(user, id, {from,to})` returns the Task 3 response shape for the submission's partner wallet.
   - access is unchanged: a partner caller reading another's submission → 404, and an out-of-chain sales manager → Forbidden
     (reuse `assertCanViewSubmission`). Copy the existing ledger access tests and point them at the new method.
2. Run → fail. 3. Implement: drop the nested `transactions` include (`take: 200`) from the submission query, and call
   `loadPointsStatement` instead (map to the existing shape, reversed to newest-first). Add
   `@Get(':id/ledger/statement') @RequirePermission('kyc:read')`.
4. Green → commit `feat(kyc): sales ledger reads the full statement via the shared loader (platform-wide)`.

## Task 5: FE statement model (pure)

**Files:** new `platform/src/lib/wallet-statement/statement-model.ts`, `__tests__/statement-model.test.ts`.

```ts
export type StatementLine =
  | { kind: 'points'; date: Date; description: string; type: string; points: number; balance: number }
  | { kind: 'payout'; date: Date; description: string; type: string; amountInr: number; utr: string };
export interface StatementDoc {
  title: string; outletName: string; outletCode: string; periodLabel: string;   // e.g. "Apr 2026 – Jun 2026"
  openingBalance: number; closingBalance: number; lines: StatementLine[];        // OLDEST first
  generatedAt: Date;
}
export function buildStatementDoc(api: StatementApiResponse, payouts: PayoutLedgerEntry[], meta: {…; from: string; to: string}): StatementDoc;
```
1. **Tests first:**
   - lines are **oldest first** (statement order), points before payout when timestamps are equal.
   - debit `points` stay **negative numbers** (`-50`, never the string `'--50'`, the regression for bug #2).
   - type labels by `transactionType`: EARNED→"Earned", BONUS→"Bonus", REVERSAL→"Reversal", CREDIT_ADJUSTMENT→"Credit adjustment",
     REDEMPTION→"Redeemed", EXPIRY→"Expired", DEBIT_ADJUSTMENT→"Debit adjustment".
   - description: credit rows with `fieldName` → `"<fieldName> · <narration>"` when there's a narration, else just `fieldName`. Other rows use `description`.
   - payout rows are filtered to the same IST month window (`istMonthKey`), exclude `FAILED`, carry `amountInr = paise/100`,
     and **have no balance**.
   - empty API + no payouts → `lines: []` with opening = closing from the API.
   - 5,000 rows → builds in < 100 ms.
2. Run → fail. 3. Implement. 4. Green → commit `feat(wallet): shared FE statement model (platform-wide)`.

## Task 6: Excel renderer

**Files:** new `statement-xlsx.ts`, `__tests__/statement-xlsx.test.ts`.

`export function statementToXlsxBlob(doc: StatementDoc): Blob` (build with `aoaToSheetSafe`, write with `XLSX.write(wb, { type: 'array', bookType: 'xlsx' })`).
Layout: rows 1–4 are the header block (title; outlet name + code; period; "Opening balance" + value), a blank row, then the header row
**Date | Description | Type | Points | Balance | Amount (Rs.) | UTR**, then the lines, then a **"Closing balance"** row. Sheet name `Wallet Statement`.

1. **Tests first** (read back with `XLSX.read(await blob.arrayBuffer())`):
   - the header row includes **"Balance"** between Points and Amount.
   - the Points/Balance cells are **numbers** (cell `t === 'n'`), so Excel can sum them.
   - Date cells are the IST `dd Mon yyyy` string (use `formatISTDate`). A row at `2026-03-31T18:45Z` renders **01 Apr 2026**.
   - payout rows have empty Points/Balance and a numeric Amount.
   - the opening and closing values appear, and **opening + Σ Points = closing** for a fixture without a shortfall.
   - a description starting with `=` is neutralised (proves `*Safe` was used).
   - empty statement → a valid workbook with the header block and a "No transactions in this period" row.
2. Run → fail. 3. Implement. 4. Green → commit `feat(wallet): statement Excel renderer with Balance column (platform-wide)`.

## Task 7: PDF renderer (jsPDF, already installed)

**Files:** new `statement-pdf.ts`, `__tests__/statement-pdf.test.ts`.

`export async function statementToPdfBlob(doc: StatementDoc): Promise<Blob>`. Lazy `await import('jspdf')` (keeps it out of
the page bundle, the same as `so-declaration.ts`). A4 portrait, `compress: false` (so tests can grep the text). Header block on
page 1, the column header **repeated on every page**, "Page n of N" footer, and a closing-balance line at the end.
Columns: Date, Description (truncate with `doc.splitTextToSize` to 1–2 lines), Type, Points (right-aligned, signed),
Balance (right-aligned), Amount (Rs.). Use `ensureSpace` from `so-declaration.ts` as the page-break pattern.
Text sanitiser `pdfSafe(s)`: `₹` → `Rs.`, and any char outside WinAnsi → `?` (Helvetica can't draw it, see D9).

1. **Tests first** (if `import('jspdf')` fails under jsdom, put `// @vitest-environment node` at the top of this file;
   the renderer needs no DOM):
   - output starts with `%PDF`; the decoded text contains "Opening balance", "Closing balance" and "Balance".
   - the 2,500-row statement has > 1 page (parse `/Type /Page` count, or expose `pageCount` from a helper),
     and the column header text occurs once per page.
   - the 5,000-row statement renders in < 3 s (guards the "thousands of rows" case).
   - empty statement → exactly 1 page containing "No transactions in this period".
   - `pdfSafe('₹100 हिंदी')` → `'Rs.100 ?????'` (character count per the implementation, so assert with a regex `/^Rs\.100 \?+$/`).
2. Run → fail. 3. Implement. 4. Green → commit `feat(wallet): statement PDF renderer via jsPDF (platform-wide)`.

## Task 8: Shared format-picker button

**Files:** new `platform/src/components/wallet/statement-download-button.tsx`, `__tests__/statement-download-button.test.tsx`.

Props: `{ disabled: boolean; loadDoc: () => Promise<StatementDoc>; fileBase: string }`. One **"Download"** button
(`Download` icon, same pill classes as today's Excel button) opens a small popover with two options, **"Excel (.xlsx)"**
and **"PDF"**. Choosing one runs `loadDoc()` → renderer → `downloadBlob(blob, \`${fileBase}.xlsx|.pdf\`)`. While
working, the button shows a spinner and is disabled. On error it shows an inline "Couldn't download. Try again."

1. **Tests first** (mock `@/lib/download` and both renderers):
   - disabled when `disabled` (and the popover can't open).
   - opening the popover shows both options with `role="menuitem"`, and `Escape` or an outside click closes it.
   - Excel calls `statementToXlsxBlob` and `downloadBlob(_, 'x.xlsx')`. PDF calls `statementToPdfBlob` and `'x.pdf'`.
   - a double-click while loading triggers only one download.
   - a rejected `loadDoc` shows the error text and re-enables the button.
2. Run → fail. 3. Implement. 4. Green → commit `feat(wallet): Excel/PDF statement download picker (platform-wide)`.

## Task 9: Wire the partner wallet page

**Files:** `platform/src/app/partner/wallet/page.tsx`, existing tests in `platform/src/app/partner/wallet/__tests__/`
(**`wallet-api.test.tsx`, `statement-layout.test.tsx`, `kpi-filter.test.tsx`, `narration.test.tsx`, `presence-cards.test.tsx`,
`default-period.test.tsx`, `pending-payout.test.tsx` all mock `/api/wallet/transactions` and WILL need updating**).

1. **Tests first:**
   - the page fetches `/api/wallet/statement` (no params) and **not** `/api/wallet/transactions`. A 25-row fixture shows
     **25** points rows on screen (regression for the 20-row truncation, only if D5 = A).
   - the statement controls row contains the new Download button (replace the `excel-btn` assertion in `statement-layout.test.tsx`; keep a `data-testid="statement-download-btn"`).
   - picking Excel calls `fetch('/api/wallet/statement?from=<activeFrom>&to=<activeTo>')` and then the xlsx renderer. **The export
     ignores the Earn/Burn and KPI chips** (D4 = A): with "Burn" selected, the doc still contains the credit rows.
   - the button is disabled when the selected period has no rows.
2. Run → fail. 3. Implement: replace the transactions fetch with the statement fetch. Map `rows` (reversed to newest-first)
   through the existing `mapApiTransaction` (the shape is compatible). Delete `downloadCombinedStatement` and the
   `xlsx` import. Render `<StatementDownloadButton fileBase={\`wallet-statement-${identity.outletCode}-${activeFrom}_${activeTo}\`} …/>`.
   The title is fixed **"Wallet Statement"** (D11).
4. Green → commit `feat(partner): wallet statement Excel/PDF picker + Balance column (platform-wide)`.

## Task 10: Wire the sales outlet ledger page

**Files:** `platform/src/app/sales/kyc/[id]/ledger/page.tsx`, its `__tests__/` (update the ones that assert the Excel button).

1. **Tests first:** the Download picker is present; Excel/PDF call `/api/kyc/<id>/ledger/statement?from=&to=` and the renderers
   with the outlet name and code from `meta`; the button is disabled with no rows; the on-screen list still renders.
2. Run → fail. 3. Implement: delete `downloadLedger` and the `xlsx` import, and use the shared button (merge `rawPayouts` via `buildStatementDoc`).
4. Green → commit `feat(sales): outlet ledger Excel/PDF picker via shared statement builder (platform-wide)`.

## Task 11: Gates + doc sweep

1. `bash scripts/gates.sh` → must print `GATES: ✅ all passed.` (exit 0). If a suite flakes, re-run that ONE file alone
   to tell a flake from a regression. Never weaken an assertion to pass.
2. Docs (CLAUDE.md agreement 5): add a line to `platform/docs/plans/RESUME.md` (develop-ahead list) and the
   `GO-LIVE-ISSUE-LIST.md` tracker noting the feature, the two fixed bugs (20-row truncation, `--50` sign) and the
   200-row sales cap removal. Mark this plan's Status as BUILT.
3. Commit `docs: wallet statement export plan → built`. **Do not push.**

---

## How to verify on staging (orchestrator/owner, after push to `develop`)

Do real logins per role (CLAUDE.md agreement 4). The owner completes OTP logins.
1. **Bajaj partner** (`https://uat-bajaj.gifsy.in`, pick an imported outlet with more than 20 events from Task 0 query (d)):
   `/partner/wallet` shows **all** events back to Apr 2025, not just 20. Download → Excel: the Balance column is present, the last
   Balance equals the "Available" figure on the balance card, and debits show `-N` (not `--N`). Download → PDF: same numbers, multi-page,
   header repeated on each page, `Rs.` for amounts.
2. Pick a mid-history range (e.g. Jul 2025–Sep 2025): the opening balance equals the Balance on the last row **before** Jul 2025 in the
   full export, and opening + Σ Points = closing.
3. An outlet with an expiry row (30-Jun-2026 FY laps) and a "Points reversed" (`DEBIT_ADJUSTMENT`) row: balances step correctly.
4. **Deoleo staging partner**: the same checks. Select "Burn" and download: the file still has the full period (by design).
5. **Sales rep** → `/sales/kyc/<id>/ledger` for the same outlet: both formats work, and the numbers match the partner download.
6. Phone-width check: the popover fits and nothing gets clipped.
7. Pre-KYC partner (no wallet): an empty-state page, and the Download button is disabled.

## Out of scope (YAGNI; don't build)
Admin outlet-wallet (GIFSY) download; admin Points-Ledger report changes; a backend-generated PDF or any new npm dependency
(`pdfkit`, `jspdf-autotable`); embedding a Unicode/Devanagari font; emailing or WhatsApp-sending statements; a per-tenant
statement template, logo or label setting; CSV; scheduled/monthly auto-statements; on-screen pagination or virtualisation;
fixing the on-screen month filter's local-TZ `getMonth()` (separate janitorial item); de-duplicating `IST_OFFSET_MIN` copies.

---

## OWNER DECISIONS (final, 2026-11-06), these override the options below

| # | Decision |
|---|---|
| D1 | **(A)** Approved as PLATFORM-WIDE. |
| D2 | **(A)** Partner wallet AND sales-rep outlet ledger, sharing one statement builder. |
| D3 | **(A)** Balance = the STORED per-row `balanceBefore`/`balanceAfter`; opening = the first in-range row's `balanceBefore`. |
| D4 | **(A)** The download covers the chosen DATE RANGE with ALL transaction types (on-screen Earn/Burn/KPI filters ignored), with opening + closing balance so it reconciles. |
| D5 | **(A)** Fix the newest-20-rows truncation on screen AND in the download (the screen uses the new endpoint). |
| D6 | **(A)** Files generated in the BROWSER with the existing `xlsx` + `jspdf`; backend returns data only. No new npm dependency except the D9 font asset. |
| D7 | **(A)** One "Download" button opening an Excel / PDF menu. |
| D8 | **(A)** ₹ payout rows interleaved, with a blank Balance cell. |
| D9 | **FINAL: keep the interim** ("Rs." for ₹; names in English letters only — non-Latin characters print as `?`, never dropped). Originally chose (B): embed a Unicode font in the PDF so ₹ and Hindi/regional (Devanagari etc.) names render: an open-licensed font (e.g. Noto Sans + Noto Sans Devanagari, SIL OFL) shipped as a static asset under `platform/public/`, lazy-loaded only when a PDF is generated. A new `public/` subdir needs the `platform/src/proxy.ts` matcher exclusion (RESUME trap 17). **Precondition:** jsPDF must shape Devanagari correctly (it has no complex-script shaping). If it can't, STOP this sub-task and go back to the owner with options rather than shipping broken text. |
| D10 | **(A)** If closing ≠ live wallet balance: show the stored values and log a server warning (no partner-facing note, don't block). |
| D11 | **(A)** Fixed title "Wallet Statement". |
| D12 | **(A)** Oldest first. |

**Task 0** (staging DB balance-chain audit) is skipped for the implementation pass (the build agent has no DB
access). It remains an orchestrator/owner step before the staging push; the backend D10 warning and its tests cover
chain-mismatch handling meanwhile.

The Out-of-scope line "embedding a Unicode/Devanagari font" is superseded by D9 (B).

## D9 FINDING (2026-11-06): jsPDF cannot shape Devanagari → owner DECIDED: keep the interim

**Owner decision (2026-11-06): keep option (6), the interim** — the PDF prints "Rs." for ₹ and names in English
letters only; any non-Latin character falls back to `?` (it is never dropped, because Helvetica's WinAnsi path is used,
not an embedded font). No font asset is shipped. The finding and the options considered are kept below for the record.

jsPDF 4.2.1 (installed) writes Unicode text by mapping each UTF-16 code unit to ONE glyph through the font's `cmap`
(`pdfEscape16` → `TTFFont.characterToGlyph`, `node_modules/jspdf/dist/jspdf.es.js`). There is no OpenType shaping:
no GSUB (conjuncts / half-forms / reph / nukta forms), no GPOS (matra and anusvara positioning), no pre-base reordering
(`ि` must draw BEFORE its consonant). jsPDF's only script processing is Arabic (`processArabic`). So with an embedded
Noto Sans Devanagari, "हिंदी" would print as ह ि ं द ी (i-matra after the consonant), "शर्मा"/"मिश्रा"/"क्षत्रिय" as
consonant + visible halant + consonant. That is broken text, so per the owner's rule the font was NOT shipped.
(Also: jsPDF silently DROPS the rest of a string at the first character the embedded font lacks — `if (t == "0") return`.)
₹ alone needs no shaping and WOULD render correctly from an embedded font.

**What shipped instead (interim, same as the plan's original D9-A):** Helvetica + `pdfSafe` — `₹` → `Rs.`, any character
outside WinAnsi → `?`. The Excel file is unaffected (₹ and Hindi render natively there). No font asset, no
`proxy.ts` matcher change.

**Options for the owner:**
- **(1) Embed Noto Sans (Latin + ₹ only, SIL OFL; a subset is a few hundred KB or less) + keep `?` for Indic** — true ₹, Indic names still `?`.
- **(2) Same as (1) + transliterate Indic names to Latin** (e.g. a small ITRANS-style table) — readable but not the original script.
- **(3) Rasterise only the non-Latin cells**: draw them on a `<canvas>` (the browser's own shaper, HarfBuzz in Chrome) with a
  lazily-loaded Noto Sans Devanagari web font and insert as images. Correct shaping, no new npm dep; those cells aren't
  selectable/searchable text, slightly larger PDF.
- **(4) Add a shaping engine** (e.g. `harfbuzzjs` WASM, a new dependency ~0.5 MB lazy) and emit shaped glyph runs into jsPDF —
  correct + selectable, but jsPDF has no glyph-ID text API, so it means patching its text path. Highest effort/risk.
- **(5) Backend PDF with `pdfkit` (uses `fontkit`, which has an Indic shaper)** — correct + selectable; reverses D6 and adds a
  backend dependency.
- **(6) Keep the interim** (`Rs.` + `?`).

## OPEN DECISIONS for the owner (answered above; kept for the record)

**D1. Approve as PLATFORM-WIDE?** This changes the partner wallet + sales ledger for all tenants incl. live Deoleo.
- **(A) Yes, approve as scoped here** ← recommended
- (B) Yes, but partner wallet only (skip Tasks 4 and 10)
- (C) No, hold

**D2. Which surfaces get the Excel/PDF picker + Balance?**
- **(A) Partner wallet AND sales outlet ledger (one shared button + builder)** ← recommended (DRY, numbers can't drift)
- (B) Partner wallet only (the sales ledger keeps its Excel-only button, which already has Balance)

**D3. Where does the Balance number come from?**
- **(A) The stored `balanceAfter` written atomically with each transaction; opening = first in-range `balanceBefore`** ← recommended
  (always matches the on-screen "Bal N" and the wallet card; truthful on clawback-shortfall rows)
- (B) Recompute as opening + running Σ signed points (diverges on clawback-shortfall and pre-FIFO-fix expiry rows)

**D4. The on-screen Earn/Burn + KPI filters: what does the download contain?**
- **(A) The full statement for the selected date range (filters ignored), with opening + closing balance** ← recommended
  (a statement must arithmetically tie out: opening + rows = closing)
- (B) Exactly the filtered rows (WYSIWYG), each with its true balance-after, and no opening/closing lines
- (C) A hybrid: filtered rows plus opening/closing (the numbers won't add up, so it's confusing)

**D5. Fix the 20-row truncation on screen too?** (Today the partner page loads only the newest 20 points rows, so the on-screen
list, date-picker bounds and Excel are all incomplete. The sales ledger is capped at 200.)
- **(A) Yes. Screen and download both use the new unpaginated statement endpoint** ← recommended
- (B) Download only (the screen keeps showing 20, so screen and file disagree)

**D6. Where are the files generated?**
- **(A) In the browser: Excel via the existing `xlsx`, PDF via the existing `jspdf`. Backend returns JSON only. No new dependency** ← recommended
- (B) Backend generates both (`xlsx` exists; PDF needs a **new dependency** `pdfkit` in `api/`)
- (C) Browser, but add `jspdf-autotable` (new dependency, less table code)

**D7. Picker UI.**
- **(A) One "Download" button → small menu: "Excel (.xlsx)" / "PDF"** ← recommended
- (B) Two side-by-side buttons "Excel" and "PDF"
- (C) A bottom-sheet modal with format + date range

**D8. ₹ payout rows in the statement.**
- **(A) Keep them interleaved (as today), with Amount + UTR and a blank Balance** ← recommended (no behaviour change)
- (B) A points-only statement (drop the payout rows from downloads)

**D9. PDF text: ₹ symbol and non-Latin (e.g. Hindi) names.**
- **(A) Use "Rs." and Latin-only Helvetica (as the existing invoice PDF does); non-Latin characters become "?"** ← recommended
- (B) Embed a Unicode font (Noto Sans + Devanagari, ~300–600 KB lazy-loaded) for a true ₹ and Hindi names

**D10. If the closing balance ≠ the live wallet balance (data drift).**
- **(A) Still show the stored values and log a server warning for ops** ← recommended (Task 0 should show 0 such wallets)
- (B) Show a "statement under review" note to the partner
- (C) Block the download

**D11. Document title.**
- **(A) Fixed "Wallet Statement" + outlet name/code + period** ← recommended (both sheets are already named this)
- (B) Use the tenant's `salesApp.ledgerLabel` (e.g. "Wallet"), which is a sales-tile label and partner-irrelevant

**D12. Row order in the downloaded file.**
- **(A) Oldest first (bank-statement order; the running balance reads top-down)** ← recommended. The screen stays newest-first
- (B) Newest first (matches the screen)
