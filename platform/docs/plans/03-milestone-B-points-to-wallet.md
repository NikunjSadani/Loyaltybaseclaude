# Milestone B · Points reach the wallet (Gap #16, High)

**This is the worked exemplar.** Later milestones say "follow Milestone B's pattern" — so do
this one carefully and understand *why* each step is shaped the way it is.

## The problem (read `spec/02-workflows.md` Workflow 2 first)

When an admin confirms a `CreditBatch`, the route
[`src/app/api/admin/credits/batches/[id]/confirm/route.ts`](../../src/app/api/admin/credits/batches/[id]/confirm/route.ts)
creates a `CreditPayoutEntry` for each **PAYOUT** row, but **does nothing with POINTS rows**.
So uploaded points are summed into `totalPoints` and then vanish — partner wallets never change.
Redemption (`lib/wallet.ts:debitPoints`) *subtracts* points, but nothing *adds* them. We fix the
add path.

## The design decision (DRY + atomic)

- **DRY:** `lib/wallet.ts` already has `creditPoints()` / `debitPoints()` that do the wallet math
  and write a `WalletTransaction`. **Do not reinvent this.** We reuse it.
- **Atomicity:** `creditPoints()` opens its *own* `prisma.$transaction`. The confirm route is
  *already inside* a transaction. Nesting transactions is wrong. So we **extract a transaction-
  aware core** (`creditPointsTx(tx, …)`) that both the public `creditPoints()` and the confirm
  route call — crediting then commits atomically with the batch confirmation.
- **YAGNI:** we are not building points expiry, locking, or tier multipliers here. Just credit.

Files you will touch: `src/lib/credits-points.ts` (new), `src/lib/wallet.ts`,
`src/app/api/admin/credits/batches/[id]/confirm/route.ts`,
`src/app/api/admin/credits/reversals/[id]/route.ts`, plus tests.

---

## Task B1 — Pure selector: which rows become point credits

**Why:** isolate the decision (no DB) so it's trivially testable. Mirrors the existing
`payoutRows` filter in the confirm route.

**RED.** Create `src/lib/__tests__/credits-points.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { pointsCreditsFromBatch } from '@/lib/credits-points';

const row = (over = {}) => ({
  outletId: 'OUT-1', outletName: 'A', fieldId: 'f1', fieldName: 'Monthly Target',
  amount: 100, narration: 'ok', awardType: 'POINTS', status: 'OK', ...over,
});

describe('pointsCreditsFromBatch', () => {
  it('selects POINTS rows that are OK and positive', () => {
    expect(pointsCreditsFromBatch([row()])).toEqual([
      { outletId: 'OUT-1', amount: 100, fieldName: 'Monthly Target', narration: 'ok' },
    ]);
  });
  it('ignores PAYOUT rows (those go to CreditPayoutEntry, not the wallet)', () => {
    expect(pointsCreditsFromBatch([row({ awardType: 'PAYOUT' })])).toEqual([]);
  });
  it('ignores non-OK rows', () => {
    expect(pointsCreditsFromBatch([row({ status: 'ERROR' })])).toEqual([]);
  });
  it('ignores zero/negative amounts', () => {
    expect(pointsCreditsFromBatch([row({ amount: 0 }), row({ amount: -5 })])).toEqual([]);
  });
  it('returns [] for no rows', () => {
    expect(pointsCreditsFromBatch([])).toEqual([]);
  });
});
```
Run `npx vitest run src/lib/__tests__/credits-points.test.ts` → fails (module missing). Good.

**GREEN.** Create `src/lib/credits-points.ts`:
```ts
export interface CreditRow {
  outletId: string; outletName: string; fieldId: string; fieldName: string;
  amount: number; narration: string; awardType: string; status: string;
}
export interface PointsCredit { outletId: string; amount: number; fieldName: string; narration: string; }

export function pointsCreditsFromBatch(rows: CreditRow[]): PointsCredit[] {
  return rows
    .filter(r => r.awardType === 'POINTS' && r.status === 'OK' && r.amount > 0)
    .map(r => ({ outletId: r.outletId, amount: r.amount, fieldName: r.fieldName, narration: r.narration ?? '' }));
}
```
Run again → green. `npx tsc --noEmit` → clean.

**Commit:** `feat(credits): add pure selector for points-credit rows`
**DoD:** all 5 tests pass; selector has no imports from prisma/next.

---

## Task B2 — Transaction-aware wallet core (DRY refactor, no behavior change)

**Why:** so crediting can join the confirm transaction. We refactor `creditPoints` to delegate to
a `tx`-aware function; **existing behavior must not change** (your safety net is a test).

**RED.** In `src/lib/__tests__/wallet-tx.test.ts`, test the new core against a *fake tx* (no real
DB — see `01-how-we-test.md` option B):
```ts
import { describe, it, expect, vi } from 'vitest';
import { creditPointsTx } from '@/lib/wallet';

it('increments earned + redeemable and writes a wallet transaction', async () => {
  const wallet = { id: 'w1', earnedPoints: 0 };
  const tx = {
    wallet: {
      findFirst: vi.fn().mockResolvedValue(wallet),
      update:    vi.fn().mockResolvedValue({ ...wallet, earnedPoints: 100 }),
    },
    walletTransaction: { create: vi.fn().mockResolvedValue({}) },
  };
  await creditPointsTx(tx as any, 'partner-1', 100, { referenceType: 'CREDIT_BATCH', referenceId: 'b1' });
  expect(tx.wallet.update).toHaveBeenCalledOnce();
  expect(tx.walletTransaction.create).toHaveBeenCalledOnce();
});
it('rejects non-positive amounts', async () => {
  await expect(creditPointsTx({} as any, 'p', 0, {})).rejects.toThrow();
});
```
Run → fails (`creditPointsTx` missing).

**GREEN.** In `src/lib/wallet.ts`, extract the inner body of `creditPoints` into a `tx`-aware
export and make the public function delegate:
```ts
export interface CreditOpts { referenceType?: string; referenceId?: string; description?: string; }

export async function creditPointsTx(tx: PrismaTx, partnerId: string, amount: number, opts: CreditOpts = {}): Promise<void> {
  if (amount <= 0) throw new WalletError('Amount must be positive', 'INVALID_AMOUNT');
  const wallet = await getWalletByPartnerId(partnerId, tx);
  const updated = await tx.wallet.update({
    where: { id: wallet.id },
    data: {
      earnedPoints: { increment: amount }, redeemablePoints: { increment: amount },
      lifetimeEarned: { increment: amount }, lastTransactionAt: new Date(),
    },
  });
  await tx.walletTransaction.create({
    data: {
      walletId: wallet.id, transactionType: 'CREDIT_POINTS_EARNED', points: amount,
      balanceBefore: updated.earnedPoints - amount, balanceAfter: updated.earnedPoints,
      balanceType: 'EARNED',
      referenceType: opts.referenceType ?? null, referenceId: opts.referenceId ?? null,
      description: opts.description ?? null,
    },
  });
}

// public function now just owns the transaction:
export async function creditPoints(partnerId: string, amount: number, _type: string, _schemeId?: string, referenceId?: string, description?: string): Promise<void> {
  await prisma.$transaction((tx: PrismaTx) =>
    creditPointsTx(tx, partnerId, amount, { referenceType: referenceId ? 'SALES_INVOICE' : undefined, referenceId, description }));
}
```
Do the **same** for `debitPoints` → `debitPointsTx` (you'll need it in B4). Run all wallet tests
→ green. **Note:** the existing `creditPoints` callers keep working unchanged — verify by
grepping `grep -rn "creditPoints(" src` and running `npm test`.

**Commit:** `refactor(wallet): extract tx-aware creditPointsTx/debitPointsTx`
**DoD:** new core tested; old behavior unchanged; `npm test` + `tsc` clean.

---

## Task B3 — Credit points when a batch is confirmed

**Why:** the actual fix. Inside the confirm transaction, credit each POINTS row's partner.

**First, verify one assumption** (don't guess): open the confirm route and a few `CreditBatch`
rows — is `row.outletId` the **`Outlet.outletCode`** (e.g. `OUT-2026-001`) or the cuid `Outlet.id`?
Map accordingly. Below assumes `outletCode`; fix if your check says otherwise.

**RED.** A source-read *wiring* test is the **floor**, not the ceiling — it proves the route calls
the right thing, not that crediting works. **Path matters:** the confirm route is in the `confirm/`
subdir, so the test goes in
`src/app/api/admin/credits/batches/[id]/confirm/__tests__/confirm-wiring.test.ts` and reads
`../route.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
const src = readFileSync(resolve(__dirname, '../route.ts'), 'utf-8');
describe('confirm route credits points', () => {
  it('credits points on confirm', () => expect(src).toMatch(/creditBatchPoints/));
});
```
Run → fails.

**Stronger test (do this — it's money).** Wiring alone proves nothing ran. Extract the credit loop
into a `tx`-aware `creditBatchPoints(tx, rows, clientId, batchId)` in `src/lib/credits-points.ts`
and unit-test it with a **fake `tx`** (`01-how-we-test.md` option B): a wallet-less outlet is
**skipped** and reported, each creditable outlet produces one `tx.walletTransaction.create`, and
PAYOUT/non-OK rows are ignored.

**GREEN.** In `src/lib/credits-points.ts`, add the loop (reuses B2's `creditPointsTx`):
```ts
import { creditPointsTx } from './wallet';

export async function creditBatchPoints(
  tx: any, rows: CreditRow[], clientId: string, batchId: string,
): Promise<{ credited: number; skipped: string[] }> {
  const credits = pointsCreditsFromBatch(rows);
  if (credits.length === 0) return { credited: 0, skipped: [] };
  // row.outletId is the admin-facing Outlet ID (outletCode) — confirmed in lib/credits-payouts-parser.ts
  const outlets = await tx.outlet.findMany({
    where: { outletCode: { in: credits.map(c => c.outletId) }, partner: { user: { clientId } } },
    select: { outletCode: true, partnerId: true, partner: { select: { wallet: { select: { id: true } } } } },
  });
  const byCode = new Map(outlets.map((o: any) => [o.outletCode, o]));
  const skipped: string[] = []; let credited = 0;
  for (const c of credits) {
    const o = byCode.get(c.outletId);
    if (!o || !o.partner?.wallet) { skipped.push(c.outletId); continue; } // no wallet (e.g. non-KYC outlet)
    await creditPointsTx(tx, o.partnerId, c.amount, {
      referenceType: 'CREDIT_BATCH', referenceId: batchId,
      description: `${c.fieldName}${c.narration ? ` — ${c.narration}` : ''}`,
    });
    credited++;
  }
  return { credited, skipped };
}
```
> Verify the back-relation on `ChannelPartner` is named `wallet` (Prisma infers it from
> `Wallet.partner`); adjust if not.

Then the confirm route just calls it **inside the existing `prisma.$transaction`**, after the
payout entries:
```ts
import { creditBatchPoints } from '@/lib/credits-points';
const pointsResult = await creditBatchPoints(tx, rows, clientId, id);
```
Return `pointsResult.skipped` in the response so the admin sees which POINTS rows weren't credited.
Run → green. **Idempotency is free:** the route rejects any batch not in `PENDING_CONFIRM`, so a
batch is confirmed (and credited) at most once.

**Two honest caveats — state these in the PR and the gap register:**
1. **Balance only, not the ledger.** `creditPointsTx` updates wallet counters + `WalletTransaction`
   but does **not** write `PointsLedger`. Expiry/locking read `PointsLedger`, so these points won't
   expire yet — #16 is *balance-resolved*; the ledger/expiry wiring is a separate follow-up task.
2. **Wallet-less outlets are skipped, not failed** (non-KYC outlets have no wallet). Confirm with the
   owner this is desired vs. auto-creating a wallet.

**Manually verify** (you ran the app in onboarding): with `DEMO_MODE` off and a dev DB, confirm a
batch containing a POINTS row, then `GET /api/wallet` for that partner and see the balance rise;
check a `WalletTransaction` row exists with `referenceType: 'CREDIT_BATCH'`.

**Commit:** `fix(credits): credit points to wallet on batch confirm (#16)`
**DoD:** `creditBatchPoints` unit-tested (incl. the skip-on-no-wallet path); wiring test green;
manual check shows balance + `WalletTransaction` updated and `skipped` returned; `tsc`/`lint` clean.

---

## Task B4 — Reverse points on an approved POINTS reversal

**Why:** symmetry. A `CreditReversal` with `awardType: POINTS` that Gifsy approves must **debit**
the wallet, or balances drift. Follow B3's shape in
[`src/app/api/admin/credits/reversals/[id]/route.ts`](../../src/app/api/admin/credits/reversals/[id]/route.ts)
(the PATCH that approves a reversal): when status becomes `APPROVED`/`PARTIAL` and
`awardType === 'POINTS'`, resolve the partner and call `debitPointsTx(tx, partnerId, approvedAmount, …)`
inside the approval transaction. `debitPointsTx` already throws `InsufficientPointsError` — decide
with the spec whether to block or clamp (ask if unsure).

**Test:** a wiring test (`debitPointsTx` referenced) + a `debitPointsTx` unit test (fake tx,
including the insufficient-points path).

**Commit:** `fix(credits): debit points on approved points reversal`

---

## Task B5 — Close the loop in the docs

Update [`docs/spec/gap-register.md`](../spec/gap-register.md): move **#16** to *balance-resolved*
(points credited on confirm, debited on reversal) and **add a new gap** for the `PointsLedger`/
expiry follow-up + the wallet-less-outlet handling. Add to `spec/02-workflows.md` WF2 side-effects:
"POINTS rows → `creditBatchPoints` on confirm; wallet-less outlets skipped + reported." 

**Commit:** `docs(spec): mark gap #16 resolved (points credited to wallet)`

> Done with Milestone B you've practiced the whole loop: pure logic + tests, a DRY refactor with
> a safety-net test, a wired transaction, symmetry, and doc hygiene. The next milestones lean on
> exactly these moves.
