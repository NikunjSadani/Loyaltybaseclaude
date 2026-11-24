import {
  applyBps,
  buildFundStatement,
  chargeFor,
  periodSummary,
  rateInForce,
  type FundManualEntry,
  type FundRateRow,
  type FundSpendItem,
} from './fund-statement.engine';
import { cashItem, creditItem, splitPaise, tdsItems, voucherItem, type CreditEntryRow, type Tds194cEntry, type VoucherOrderRow } from './fund-sources.loader';

// Dates are computed relative to a fixed anchor inside the test (never a hard-coded "future" date — the engine is
// pure and has no clock, so any anchor works).
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

const feeRate = (o: Partial<FundRateRow> & { effectiveFrom: Date }): FundRateRow => ({
  kind: 'AGENCY_FEE',
  feeType: 'PERCENT',
  rateBps: 500,
  createdAt: o.effectiveFrom,
  ...o,
});
const discRate = (rewardId: string, rateBps: number, effectiveFrom: Date, createdAt = effectiveFrom): FundRateRow => ({
  kind: 'VOUCHER_DISCOUNT',
  rewardId,
  rateBps,
  effectiveFrom,
  createdAt,
});

const item = (o: Partial<FundSpendItem> & Pick<FundSpendItem, 'key' | 'type' | 'facePaise' | 'committedAt'>): FundSpendItem => ({
  ref: o.key,
  description: o.key,
  source: { kind: 'redemptionOrder', id: o.key },
  status: 'COMMITTED',
  ...o,
});
const entry = (o: Partial<FundManualEntry> & Pick<FundManualEntry, 'id' | 'kind' | 'amountPaise' | 'date'>): FundManualEntry => ({
  ref: o.id,
  note: null,
  ...o,
});

describe('fund engine — rates', () => {
  it('rateInForce picks the latest effectiveFrom ≤ the date; same-day ties → latest createdAt', () => {
    const rows = [
      discRate('b', 300, day(0), day(0)),
      discRate('b', 400, day(10), day(10)),
      discRate('b', 450, day(10), day(11)), // same-day correction recorded later wins
      discRate('b', 900, day(20), day(1)), // future-dated row not yet in force before day 20
    ];
    expect(rateInForce(rows, day(5))!.rateBps).toBe(300);
    expect(rateInForce(rows, day(10))!.rateBps).toBe(450);
    expect(rateInForce(rows, day(19))!.rateBps).toBe(450);
    expect(rateInForce(rows, day(20))!.rateBps).toBe(900);
    expect(rateInForce(rows, new Date(day(0).getTime() - 1))).toBeNull();
  });

  it('applyBps rounds half-up to the paisa and mirrors negatives', () => {
    expect(applyBps(10_000n, 300)).toBe(300n); // 3% of ₹100
    expect(applyBps(333n, 250)).toBe(8n); // 8.325 → 8
    expect(applyBps(334n, 250)).toBe(8n); // 8.35 → 8 (half-up at .5 only)
    expect(applyBps(340n, 250)).toBe(9n); // 8.5 → 9
    expect(applyBps(-340n, 250)).toBe(-9n);
    expect(applyBps(10_000n, 0)).toBe(0n);
  });
});

describe('fund engine — charge per spend type', () => {
  const amazon = 'rw-amazon';
  it('voucher: face − the item discount at the rate in force on the COMMIT date', () => {
    const rates = [discRate(amazon, 300, day(0)), discRate(amazon, 200, day(30))];
    const before = chargeFor(item({ key: 'v1', type: 'VOUCHER', facePaise: 100_000n, committedAt: day(29), rewardId: amazon }), rates);
    expect(before).toMatchObject({ discountPaise: 3_000n, feePaise: 0n, chargedPaise: 97_000n, rateLabel: '3%', flags: [] });
    const after = chargeFor(item({ key: 'v2', type: 'VOUCHER', facePaise: 100_000n, committedAt: day(30), rewardId: amazon }), rates);
    expect(after).toMatchObject({ discountPaise: 2_000n, chargedPaise: 98_000n, rateLabel: '2%' });
  });

  it('voucher with no rate for its item → face value + NO_ITEM_RATE (another item\'s rate never applies)', () => {
    const rates = [discRate(amazon, 300, day(0))];
    const c = chargeFor(item({ key: 'v', type: 'VOUCHER', facePaise: 50_000n, committedAt: day(5), rewardId: 'rw-flipkart' }), rates);
    expect(c).toMatchObject({ discountPaise: 0n, chargedPaise: 50_000n, flags: ['NO_ITEM_RATE'] });
    const noKey = chargeFor(item({ key: 'v', type: 'VOUCHER', facePaise: 50_000n, committedAt: day(5), rewardId: null }), [discRate('', 300, day(0))]);
    expect(noKey.flags).toEqual(['NO_ITEM_RATE']);
  });

  it('voucher discount committed BEFORE the first rate → face value + flagged', () => {
    const c = chargeFor(item({ key: 'v', type: 'VOUCHER', facePaise: 10_000n, committedAt: day(1), rewardId: amazon }), [discRate(amazon, 300, day(2))]);
    expect(c.chargedPaise).toBe(10_000n);
    expect(c.flags).toEqual(['NO_ITEM_RATE']);
  });

  it.each(['CASH_REDEMPTION', 'CREDIT_PAYOUT', 'VISIBILITY_PAYOUT'] as const)('%s: face + % agency fee', (type) => {
    const c = chargeFor(item({ key: 'p', type, facePaise: 200_000n, committedAt: day(3) }), [feeRate({ effectiveFrom: day(0), rateBps: 250 })]);
    expect(c).toMatchObject({ feePaise: 5_000n, discountPaise: 0n, chargedPaise: 205_000n, rateLabel: '2.5%' });
  });

  it('flat ₹ fee per payout line', () => {
    const c = chargeFor(item({ key: 'p', type: 'CREDIT_PAYOUT', facePaise: 123_45n, committedAt: day(3) }), [
      feeRate({ effectiveFrom: day(0), feeType: 'FLAT', rateBps: null, flatPaise: 15_00n }),
    ]);
    expect(c).toMatchObject({ feePaise: 15_00n, chargedPaise: 138_45n });
    expect(c.rateLabel).toContain('flat');
  });

  it('fee type change on a date: % before, flat after (rate on the commit date)', () => {
    const rates = [feeRate({ effectiveFrom: day(0), rateBps: 1000 }), feeRate({ effectiveFrom: day(10), feeType: 'FLAT', rateBps: null, flatPaise: 500n })];
    expect(chargeFor(item({ key: 'a', type: 'CASH_REDEMPTION', facePaise: 10_000n, committedAt: day(9) }), rates).feePaise).toBe(1_000n);
    expect(chargeFor(item({ key: 'b', type: 'CASH_REDEMPTION', facePaise: 10_000n, committedAt: day(10) }), rates).feePaise).toBe(500n);
  });

  it('payout with no agency fee set → no fee + NO_FEE_RATE', () => {
    const c = chargeFor(item({ key: 'p', type: 'VISIBILITY_PAYOUT', facePaise: 10_000n, committedAt: day(3) }), []);
    expect(c).toMatchObject({ feePaise: 0n, chargedPaise: 10_000n, flags: ['NO_FEE_RATE'] });
  });

  it('TDS 194C: charged = the TDS (no fee, no discount); a negative true-up is a credit', () => {
    const rates = [feeRate({ effectiveFrom: day(0) })];
    expect(chargeFor(item({ key: 't', type: 'TDS_194C', facePaise: 20_41n, committedAt: day(3) }), rates)).toMatchObject({
      tdsPaise: 20_41n,
      feePaise: 0n,
      chargedPaise: 20_41n,
    });
    expect(chargeFor(item({ key: 't', type: 'TDS_194C', facePaise: -5_00n, committedAt: day(3) }), rates).chargedPaise).toBe(-5_00n);
  });
});

describe('fund engine — statement', () => {
  const rates: FundRateRow[] = [feeRate({ effectiveFrom: day(0), rateBps: 1000 }), discRate('rw-amazon', 300, day(0))];

  it('balance = opening + receipts + adjustments − committed − paid; returned nets to zero; running balance', () => {
    const stmt = buildFundStatement({
      rates,
      entries: [
        entry({ id: 'o', kind: 'OPENING_BALANCE', amountPaise: 1_000_000n, date: day(0) }),
        entry({ id: 'r1', kind: 'RECEIPT', amountPaise: 500_000n, date: day(2) }),
        entry({ id: 'a1', kind: 'ADJUSTMENT', amountPaise: -10_000n, date: day(6), note: 'bank charges' }),
      ],
      items: [
        item({ key: 'v-paid', type: 'VOUCHER', facePaise: 100_000n, committedAt: day(1), rewardId: 'rw-amazon', status: 'PAID', paidAt: day(1) }),
        item({ key: 'c-committed', type: 'CASH_REDEMPTION', facePaise: 50_000n, committedAt: day(3) }),
        item({ key: 'cp-returned', type: 'CREDIT_PAYOUT', facePaise: 200_000n, committedAt: day(4), status: 'RETURNED', returnedAt: day(5) }),
      ],
    });
    // v-paid: 97,000 · c-committed: 55,000 · cp-returned: 220,000 out then back.
    expect(stmt.totals).toMatchObject({
      openingPaise: 1_000_000n,
      receiptsPaise: 500_000n,
      adjustmentsPaise: -10_000n,
      paidPaise: 97_000n,
      committedPaise: 55_000n,
      returnedPaise: 220_000n,
      balancePaise: 1_000_000n + 500_000n - 10_000n - 97_000n - 55_000n,
      faceTotalPaise: 150_000n,
      discountTotalPaise: 3_000n,
      feeTotalPaise: 5_000n,
    });
    expect(stmt.lines.map((l) => [l.event, l.amountPaise, l.balancePaise])).toEqual([
      ['OPENING', 1_000_000n, 1_000_000n],
      ['CHARGE', -97_000n, 903_000n],
      ['RECEIPT', 500_000n, 1_403_000n],
      ['CHARGE', -55_000n, 1_348_000n],
      ['CHARGE', -220_000n, 1_128_000n],
      ['RETURN', 220_000n, 1_348_000n],
      ['ADJUSTMENT', -10_000n, 1_338_000n],
    ]);
    expect(stmt.lines[stmt.lines.length - 1].balancePaise).toBe(stmt.totals.balancePaise);
    // The returned item's CHARGE line shows the item's current status.
    expect(stmt.lines[4].status).toBe('RETURNED');
    expect(stmt.lines[6].description).toContain('bank charges');
    const cp = stmt.byType.find((b) => b.type === 'CREDIT_PAYOUT')!;
    expect(cp).toMatchObject({ count: 1, returnedPaise: 220_000n, netChargedPaise: 0n });
  });

  it('opening cut-off: spend committed before the opening date is ignored; its later return is listed, not credited', () => {
    const stmt = buildFundStatement({
      rates,
      entries: [entry({ id: 'o', kind: 'OPENING_BALANCE', amountPaise: 100_000n, date: day(10) })],
      items: [
        item({ key: 'old-paid', type: 'CASH_REDEMPTION', facePaise: 9_999n, committedAt: day(9), status: 'PAID', paidAt: day(11) }),
        item({ key: 'old-returned', type: 'VOUCHER', facePaise: 5_000n, committedAt: day(9), status: 'RETURNED', returnedAt: day(12), rewardId: 'rw-amazon' }),
        item({ key: 'old-returned-early', type: 'VOUCHER', facePaise: 1_000n, committedAt: day(8), status: 'RETURNED', returnedAt: day(9) }),
        item({ key: 'on-cutoff', type: 'CASH_REDEMPTION', facePaise: 10_000n, committedAt: day(10) }),
      ],
    });
    expect(stmt.lines.map((l) => l.ref)).toEqual(['o', 'on-cutoff']);
    expect(stmt.totals.balancePaise).toBe(100_000n - 11_000n);
    expect(stmt.preOpeningReturns.items.map((i) => i.ref)).toEqual(['old-returned']);
    expect(stmt.preOpeningReturns.facePaise).toBe(5_000n);
  });

  it('receipts / adjustments dated before the opening date are excluded and listed', () => {
    const stmt = buildFundStatement({
      rates,
      entries: [
        entry({ id: 'r0', kind: 'RECEIPT', amountPaise: 7_000n, date: day(1) }),
        entry({ id: 'o', kind: 'OPENING_BALANCE', amountPaise: 100n, date: day(2) }),
      ],
      items: [],
    });
    expect(stmt.totals.receiptsPaise).toBe(0n);
    expect(stmt.totals.balancePaise).toBe(100n);
    expect(stmt.excludedEntries.map((e) => e.id)).toEqual(['r0']);
  });

  it('no opening balance → all history counts (openingDate null)', () => {
    const stmt = buildFundStatement({ rates, entries: [], items: [item({ key: 'x', type: 'CASH_REDEMPTION', facePaise: 1_000n, committedAt: day(-400) })] });
    expect(stmt.openingDate).toBeNull();
    // Committed before the first fee rate → no fee (flagged), charged at face.
    expect(stmt.totals.balancePaise).toBe(-1_000n);
    expect(stmt.flagCounts.NO_FEE_RATE).toBe(1);
  });

  it('the opening line always leads even when spend is on the same day', () => {
    const stmt = buildFundStatement({
      rates,
      entries: [entry({ id: 'o', kind: 'OPENING_BALANCE', amountPaise: 5_000n, date: day(3) })],
      items: [item({ key: 'same-day', type: 'CASH_REDEMPTION', facePaise: 1_000n, committedAt: day(3) })],
    });
    expect(stmt.lines[0].event).toBe('OPENING');
    expect(stmt.lines[1].balancePaise).toBe(3_900n);
  });

  it('flags: missing item rate is counted per item; receivables collected (not credited)', () => {
    const stmt = buildFundStatement({
      rates: [],
      entries: [],
      items: [
        item({ key: 'v1', type: 'VOUCHER', facePaise: 1_000n, committedAt: day(1), rewardId: 'rw-x', itemLabel: 'X' }),
        item({ key: 'v2', type: 'VOUCHER', facePaise: 1_000n, committedAt: day(2), rewardId: 'rw-x', itemLabel: 'X' }),
        item({ key: 'p', type: 'CREDIT_PAYOUT', facePaise: 5_000n, committedAt: day(1), status: 'PAID', paidAt: day(2), receivablePaise: 4_900n }),
      ],
    });
    expect(stmt.flagCounts).toEqual({ NO_ITEM_RATE: 2, NO_FEE_RATE: 1 });
    expect(stmt.itemsWithoutRate).toEqual([{ rewardId: 'rw-x', itemLabel: 'X', count: 2 }]);
    expect(stmt.receivables.totalPaise).toBe(4_900n);
    expect(stmt.totals.balancePaise).toBe(-7_000n); // the receivable is NOT credited
  });

  it('a returned item with no return date nets to zero on its commit day', () => {
    const stmt = buildFundStatement({ rates, entries: [], items: [item({ key: 'r', type: 'CASH_REDEMPTION', facePaise: 1_000n, committedAt: day(1), status: 'RETURNED' })] });
    expect(stmt.lines.map((l) => l.event)).toEqual(['CHARGE', 'RETURN']);
    expect(stmt.totals.balancePaise).toBe(0n);
  });

  it('periodSummary reconciles: closing = opening + opening entry + receipts + adjustments − charges + returns', () => {
    const stmt = buildFundStatement({
      rates,
      entries: [
        entry({ id: 'o', kind: 'OPENING_BALANCE', amountPaise: 1_000_000n, date: day(0) }),
        entry({ id: 'r1', kind: 'RECEIPT', amountPaise: 200_000n, date: day(5) }),
      ],
      items: [
        item({ key: 'a', type: 'CASH_REDEMPTION', facePaise: 10_000n, committedAt: day(2) }),
        item({ key: 'b', type: 'CASH_REDEMPTION', facePaise: 20_000n, committedAt: day(4), status: 'RETURNED', returnedAt: day(8) }),
        item({ key: 'c', type: 'VOUCHER', facePaise: 30_000n, committedAt: day(6), rewardId: 'rw-amazon' }),
      ],
    });
    const p = periodSummary(stmt, day(3), day(7));
    expect(p.openingBalancePaise).toBe(1_000_000n - 11_000n);
    expect(p.receiptsPaise).toBe(200_000n);
    expect(p.chargesPaise).toBe(22_000n + 29_100n);
    expect(p.returnsPaise).toBe(0n);
    expect(p.closingBalancePaise).toBe(p.openingBalancePaise + p.openingEntryPaise + p.receiptsPaise + p.adjustmentsPaise - p.chargesPaise + p.returnsPaise);
    const all = periodSummary(stmt, null, null);
    expect(all.openingBalancePaise).toBe(0n);
    expect(all.openingEntryPaise).toBe(1_000_000n);
    expect(all.closingBalancePaise).toBe(stmt.totals.balancePaise);
    expect(all.closingBalancePaise).toBe(all.openingEntryPaise + all.receiptsPaise - all.chargesPaise + all.returnsPaise);
    const empty = periodSummary(stmt, day(100), day(101));
    expect(empty.openingBalancePaise).toBe(stmt.totals.balancePaise);
    expect(empty.closingBalancePaise).toBe(stmt.totals.balancePaise);
  });
});

describe('fund sources — mapping the source records', () => {
  const hist = (...rows: Array<[string, Date]>) => rows.map(([toStatus, createdAt]) => ({ toStatus, createdAt }));
  const order = (o: Partial<VoucherOrderRow>): VoucherOrderRow => ({
    id: 'o1',
    orderNumber: 'ORD-1',
    status: 'CONFIRMED',
    valuePaise: 50_000n,
    quantity: 1,
    totalPointsCost: 500,
    conversionRateCenti: 100,
    metadata: null,
    deliveredAt: null,
    cancelledAt: null,
    updatedAt: day(9),
    rewardId: 'rw1',
    reward: { id: 'rw1', name: 'Amazon Pay ₹500' },
    statusHistory: hist(['CONFIRMED', day(1)]),
    ...o,
  });

  it('voucher never confirmed → not a spend item', () => {
    expect(voucherItem(order({ status: 'CANCELLED', statusHistory: hist(['CANCELLED', day(1)]) }))).toBeNull();
  });

  it('voucher committed at the CONFIRMED history row; DELIVERED → paid at deliveredAt; priced by its catalogue ITEM (owner D4)', () => {
    const it1 = voucherItem(order({ status: 'DELIVERED', deliveredAt: day(2), statusHistory: hist(['DELIVERED', day(2)], ['CONFIRMED', day(1)]) }))!;
    expect(it1).toMatchObject({ status: 'PAID', committedAt: day(1), paidAt: day(2), facePaise: 50_000n, rewardId: 'rw1', itemLabel: 'Amazon Pay ₹500', type: 'VOUCHER' });
  });

  it('voucher refunded (valuePaise zeroed) → RETURNED at the refund row, face re-derived + flagged', () => {
    const it1 = voucherItem(
      order({
        status: 'FAILED',
        valuePaise: 0n,
        metadata: { sellingValuePaiseSnapshot: 50_000 },
        statusHistory: hist(['CONFIRMED', day(1)], ['FAILED', day(3)]),
      }),
    )!;
    expect(it1).toMatchObject({ status: 'RETURNED', returnedAt: day(3), facePaise: 50_000n });
    expect(it1.flags).toContain('FACE_RECOMPUTED');
    // No snapshot → points ÷ rate (500 pts at rate 1.00 = ₹500).
    const it2 = voucherItem(order({ status: 'RETURNED', valuePaise: 0n, statusHistory: hist(['CONFIRMED', day(1)], ['RETURNED', day(4)]) }))!;
    expect(it2.facePaise).toBe(50_000n);
    expect(it2.returnedAt).toEqual(day(4));
  });

  it('Hubble indeterminate (CONFIRMED + hubbleNeedsReconcile) → committed + flagged', () => {
    const it1 = voucherItem(order({ metadata: { hubbleNeedsReconcile: true } }))!;
    expect(it1.status).toBe('COMMITTED');
    expect(it1.flags).toContain('HUBBLE_NEEDS_RECONCILE');
  });

  it('A6: return / paid dates come only from event rows — never updatedAt; no event → flagged DATE_ESTIMATED', () => {
    const noEvent = voucherItem(order({ status: 'CANCELLED', statusHistory: hist(['CONFIRMED', day(1)]), cancelledAt: null, updatedAt: day(20) }))!;
    expect(noEvent.status).toBe('RETURNED');
    expect(noEvent.returnedAt).toBeNull(); // the engine nets it on its commit day
    expect(noEvent.flags).toContain('DATE_ESTIMATED');
    const viaCancelledAt = voucherItem(order({ status: 'CANCELLED', statusHistory: hist(['CONFIRMED', day(1)]), cancelledAt: day(3), updatedAt: day(20) }))!;
    expect(viaCancelledAt.returnedAt).toEqual(day(3));
    const deliveredNoDate = voucherItem(order({ status: 'DELIVERED', deliveredAt: null, statusHistory: hist(['CONFIRMED', day(1)]), updatedAt: day(20) }))!;
    expect(deliveredNoDate.paidAt).toBeNull();
    expect(deliveredNoDate.flags).toContain('DATE_ESTIMATED');
  });

  const txn = (o: Partial<Parameters<typeof cashItem>[0]>) => ({
    id: 't1',
    amountPaise: 30_000n,
    status: 'PENDING',
    payoutMode: 'UPI',
    createdAt: day(1),
    completedAt: null,
    reversedAt: null,
    updatedAt: day(5),
    providerRefId: null,
    redemptionOrderId: 'o1',
    batch: null,
    ...o,
  });

  it('cash: PENDING → committed at createdAt; SUCCESS → paid with UTR; FAILED → returned (status, not value)', () => {
    expect(cashItem(txn({}), { orderNumber: 'ORD-9', status: 'CONFIRMED', statusHistory: [] })).toMatchObject({ status: 'COMMITTED', committedAt: day(1), ref: 'ORD-9', facePaise: 30_000n });
    expect(cashItem(txn({ status: 'SUCCESS', completedAt: day(3), providerRefId: 'UTR1' }), undefined)).toMatchObject({ status: 'PAID', paidAt: day(3), utr: 'UTR1' });
    // A UTR-FAILED order keeps valuePaise — the return is derived from STATUS.
    expect(cashItem(txn({ status: 'FAILED' }), { orderNumber: 'X', status: 'FAILED', statusHistory: hist(['FAILED', day(4)]) })).toMatchObject({
      status: 'RETURNED',
      returnedAt: day(4),
      facePaise: 30_000n,
    });
    // A6: SUCCESS without completedAt → paid date blank + flagged (never updatedAt).
    const noDate = cashItem(txn({ status: 'SUCCESS', completedAt: null }), undefined);
    expect(noDate.paidAt).toBeNull();
    expect(noDate.flags).toContain('DATE_ESTIMATED');
    // FAILED with no order row and no reversedAt → flagged, not moved to updatedAt.
    const failedNoDate = cashItem(txn({ status: 'FAILED' }), { orderNumber: 'X', status: 'CONFIRMED', statusHistory: [] });
    expect(failedNoDate.returnedAt).toBeNull();
    expect(failedNoDate.flags).toContain('DATE_ESTIMATED');
    // Order refunded while the payout never succeeded → returned.
    expect(cashItem(txn({ status: 'HOLD' }), { orderNumber: 'X', status: 'CANCELLED', statusHistory: hist(['CANCELLED', day(2)]) }).status).toBe('RETURNED');
  });

  const entryRow = (o: Partial<CreditEntryRow>): CreditEntryRow => ({
    id: 'e1',
    fieldId: 'f-inc',
    fieldName: 'Target bonus',
    outletId: 'OUT1',
    outletName: 'Shop',
    period: '2026-10',
    amountPaise: 100_000n,
    status: 'PENDING',
    utr: null,
    paidAt: null,
    createdAt: day(1),
    updatedAt: day(6),
    batch: { batchCode: 'CB-1', sourceKind: null },
    reversalAllocations: [],
    ...o,
  });
  const vis = new Set(['f-vis']);

  it('credit payout: stream from the field; PAID → paid; REVERSED → returned; FAILED → still committed + flagged', () => {
    expect(creditItem(entryRow({}), vis)).toMatchObject({ type: 'CREDIT_PAYOUT', status: 'COMMITTED', committedAt: day(1) });
    expect(creditItem(entryRow({ fieldId: 'f-vis' }), vis)!.type).toBe('VISIBILITY_PAYOUT');
    expect(creditItem(entryRow({ status: 'PAID', paidAt: day(3), utr: 'U9' }), vis)).toMatchObject({ status: 'PAID', paidAt: day(3), utr: 'U9' });
    expect(creditItem(entryRow({ status: 'REVERSED', reversalAllocations: [{ state: 'APPLIED_CANCELLED', amountPaise: 100_000n, receivablePaise: 0n, creditReversal: { approvedAt: day(4) } }] }), vis)).toMatchObject({
      status: 'RETURNED',
      returnedAt: day(4),
    });
    const failed = creditItem(entryRow({ status: 'FAILED' }), vis)!;
    expect(failed.status).toBe('COMMITTED');
    expect(failed.flags).toEqual(['FAILED_AWAITING_REBANK']);
  });

  it('credit payout PAID then reversed → stays paid + receivable (net received; legacy row → gross)', () => {
    const a = creditItem(entryRow({ status: 'PAID', paidAt: day(2), reversalAllocations: [{ state: 'APPLIED_RECEIVABLE', amountPaise: 100_000n, receivablePaise: 98_000n, creditReversal: { approvedAt: day(5) } }] }), vis)!;
    expect(a).toMatchObject({ status: 'PAID', receivablePaise: 98_000n });
    const legacy = creditItem(entryRow({ status: 'PAID', paidAt: day(2), reversalAllocations: [{ state: 'APPLIED_RECEIVABLE', amountPaise: 100_000n, receivablePaise: 0n, creditReversal: { approvedAt: day(5) } }] }), vis)!;
    expect(legacy.receivablePaise).toBe(100_000n);
    const released = creditItem(entryRow({ status: 'PAID', paidAt: day(2), reversalAllocations: [{ state: 'RELEASED', amountPaise: 100_000n, receivablePaise: 0n, creditReversal: { approvedAt: day(5) } }] }), vis)!;
    expect(released.receivablePaise).toBe(0n);
  });

  it('imported vendor history (VENDOR_IMPORT) is not spend from the advance', () => {
    expect(creditItem(entryRow({ batch: { batchCode: 'IMP', sourceKind: 'VENDOR_IMPORT' } }), vis)).toBeNull();
  });

  it('A1: a paid entry reversed afterwards (incl. a fully TDS-withheld one flipped PAID → REVERSED) stays PAID — never "returned"', () => {
    // ₹1,000 payout + 2% agency fee, fully withheld as TDS (settled TDS-WITHHELD, paidAt set), then reversed.
    const e = creditItem(entryRow({ amountPaise: 100_000n, status: 'REVERSED', paidAt: day(2), utr: 'TDS-WITHHELD-PD-1', reversalAllocations: [{ state: 'APPLIED_CANCELLED', amountPaise: 100_000n, receivablePaise: 0n, creditReversal: { approvedAt: day(5) } }] }), vis)!;
    expect(e).toMatchObject({ status: 'PAID', paidAt: day(2), receivablePaise: 0n, returnedAt: null });
    const stmt = buildFundStatement({ rates: [feeRate({ effectiveFrom: day(0), rateBps: 200 })], entries: [], items: [e] });
    expect(stmt.totals).toMatchObject({ paidPaise: 102_000n, returnedPaise: 0n, balancePaise: -102_000n });
    expect(stmt.lines.map((l) => l.event)).toEqual(['CHARGE']);
    // Never paid (PENDING/FAILED → REVERSED): returned at the reversal's approval.
    const unpaid = creditItem(entryRow({ status: 'REVERSED', paidAt: null, reversalAllocations: [{ state: 'APPLIED_CANCELLED', amountPaise: 100_000n, receivablePaise: 0n, creditReversal: { approvedAt: day(4) } }] }), vis)!;
    expect(unpaid).toMatchObject({ status: 'RETURNED', returnedAt: day(4) });
  });

  it('A2: legacy payout reversal (no allocation) → the consumed PAID entry is a receivable of its net amount', () => {
    const paid = creditItem(entryRow({ status: 'PAID', paidAt: day(2) }), vis, { approvedAt: day(6), receivablePaise: 95_000n })!;
    expect(paid).toMatchObject({ status: 'PAID', receivablePaise: 95_000n });
    // An allocation, when present, wins over the legacy figure (never both).
    const both = creditItem(entryRow({ status: 'PAID', paidAt: day(2), reversalAllocations: [{ state: 'APPLIED_RECEIVABLE', amountPaise: 100_000n, receivablePaise: 90_000n, creditReversal: { approvedAt: day(5) } }] }), vis, { approvedAt: day(6), receivablePaise: 95_000n })!;
    expect(both.receivablePaise).toBe(90_000n);
    // Legacy PENDING → REVERSED: returned at the legacy reversal's approvedAt.
    const unpaid = creditItem(entryRow({ status: 'REVERSED' }), vis, { approvedAt: day(6), receivablePaise: 0n })!;
    expect(unpaid).toMatchObject({ status: 'RETURNED', returnedAt: day(6) });
    // No event anywhere → flagged.
    expect(creditItem(entryRow({ status: 'REVERSED' }), vis)!.flags).toContain('DATE_ESTIMATED');
    // Orphan legacy receivables (no entries recorded) are listed + totalled, never credited.
    const stmt = buildFundStatement({
      rates: [],
      entries: [],
      items: [],
      extraReceivables: [{ ref: 'Reversal r1', description: 'x', type: 'CREDIT_PAYOUT', source: { kind: 'creditReversal', id: 'r1' }, paidAt: null, amountPaise: 12_300n }],
    });
    expect(stmt.receivables.totalPaise).toBe(12_300n);
    expect(stmt.totals.balancePaise).toBe(0n);
  });

  it('splitPaise: largest remainder, exact total, negatives mirrored', () => {
    expect(splitPaise(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(splitPaise(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
    expect(splitPaise(1_000n, [700n, 300n])).toEqual([700n, 300n]);
    expect(splitPaise(5n, [0n, 0n])).toEqual([0n, 0n]);
  });

  describe('D3: 194C TDS dated with its payout', () => {
    const payout = (id: string, o: Partial<Omit<Tds194cEntry, 'item'>> & { item?: Partial<FundSpendItem> } = {}): Tds194cEntry => ({
      id,
      outletId: 'OUT1',
      period: '2026-10',
      amountPaise: 100_000n,
      status: 'PAID',
      payeePan: 'ABCDE1234F',
      ...o,
      item: item({ key: 'cpe:' + id, type: 'VISIBILITY_PAYOUT', facePaise: o.amountPaise ?? 100_000n, committedAt: day(10), status: 'PAID', paidAt: day(12), ...(o.item ?? {}) }),
    });
    const rec = (id: string, pan: string, share: bigint, at = day(15)) => ({ id, panNumber: pan, fyLabel: '2026-27', tenantSharePaise: share, createdAt: at });

    it('the PAN-year net recovery (true-ups included) is shared by amount over that PAN\'s payouts, on each payout\'s commit date and status', () => {
      const lines = tdsItems(
        [rec('r1', 'abcde1234f', 3_000n), rec('r2', 'ABCDE1234F', -100n)],
        [
          payout('p1', { amountPaise: 200_000n, item: { committedAt: day(10) } }),
          payout('p2', { amountPaise: 100_000n, item: { committedAt: day(11), status: 'COMMITTED', paidAt: null } }),
          payout('p3', { status: 'PENDING' }), // never in a bank file → not in the base
          payout('p4', { payeePan: 'OTHER9999Z' }),
        ],
      );
      expect(lines.map((l) => [l.source.id, l.facePaise, l.committedAt, l.status])).toEqual([
        ['p1', 1_933n, day(10), 'PAID'],
        ['p2', 967n, day(11), 'COMMITTED'],
      ]);
      expect(lines.reduce((x, l) => x + l.facePaise, 0n)).toBe(2_900n);
      expect(lines[0].description).toContain('…234F');
      expect(lines[0].description).not.toContain('ABCDE');
    });

    it('a payout reversed before payment takes its TDS share back with it (returned); before the opening date → excluded', () => {
      const [l] = tdsItems([rec('r1', 'ABCDE1234F', 2_000n)], [payout('p1', { status: 'REVERSED', item: { status: 'RETURNED', paidAt: null, returnedAt: day(13) } })]);
      expect(l).toMatchObject({ status: 'RETURNED', returnedAt: day(13), facePaise: 2_000n });
      const stmt = buildFundStatement({
        rates: [],
        entries: [entry({ id: 'o', kind: 'OPENING_BALANCE', amountPaise: 0n, date: day(11) })],
        items: tdsItems([rec('r1', 'ABCDE1234F', 2_000n)], [payout('p1')]), // payout committed day 10 < opening day 11
      });
      expect(stmt.totals.tdsTotalPaise).toBe(0n);
    });

    it('no-PAN 194C recovery is matched to the outlet\'s payouts', () => {
      const lines = tdsItems([rec('r1', '__NO_PAN__:OUT7', 500n)], [payout('p1', { outletId: 'OUT7', payeePan: null }), payout('p2', { outletId: 'OUT8', payeePan: null })]);
      expect(lines.map((l) => [l.source.id, l.facePaise])).toEqual([['p1', 500n]]);
    });

    it('no matching payout → kept on the day it was recorded and flagged TDS_UNALLOCATED (never guessed silently)', () => {
      const lines = tdsItems([rec('r1', 'ZZZZZ0000Z', 700n, day(20)), rec('r2', 'ZZZZZ0000Z', -100n, day(25))], []);
      expect(lines.map((l) => [l.source.kind, l.facePaise, l.committedAt, l.flags])).toEqual([
        ['tdsRecoveryEntry', 700n, day(20), ['TDS_UNALLOCATED']],
        ['tdsRecoveryEntry', -100n, day(25), ['TDS_UNALLOCATED']],
      ]);
      expect(lines[1].description).toContain('true-up');
    });
  });

  it('D1: a confirmed back-dated rate change shows as an informational line (amount 0, balance unchanged)', () => {
    const stmt = buildFundStatement({
      rates: [],
      entries: [entry({ id: 'r', kind: 'RECEIPT', amountPaise: 1_000n, date: day(1) })],
      items: [],
      rateChanges: [{ id: 'rate1', at: day(3), effectiveFrom: day(0), label: 'Agency fee change', linesRepriced: 4, deltaPaise: -2_500n }],
    });
    const info = stmt.lines.find((l) => l.event === 'RATE_CHANGE')!;
    expect(info.amountPaise).toBe(0n);
    expect(info.balancePaise).toBe(1_000n);
    expect(info.description).toMatch(/^Rate change on .*: 4 lines re-priced from .*, balance changed by −₹25\.00$/);
    expect(stmt.totals.balancePaise).toBe(1_000n);
  });
});

