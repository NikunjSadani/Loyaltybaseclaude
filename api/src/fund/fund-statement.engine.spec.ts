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
import { cashItem, creditItem, tdsItem, voucherItem, type CreditEntryRow, type VoucherOrderRow } from './fund-sources.loader';
import { voucherBrandOf } from './fund-brand';

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
const discRate = (brandKey: string, rateBps: number, effectiveFrom: Date, createdAt = effectiveFrom): FundRateRow => ({
  kind: 'VOUCHER_DISCOUNT',
  brandKey,
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
  const amazon = 'brand:amazon';
  it('voucher: face − brand discount at the rate in force on the COMMIT date', () => {
    const rates = [discRate(amazon, 300, day(0)), discRate(amazon, 200, day(30))];
    const before = chargeFor(item({ key: 'v1', type: 'VOUCHER', facePaise: 100_000n, committedAt: day(29), brandKey: amazon }), rates);
    expect(before).toMatchObject({ discountPaise: 3_000n, feePaise: 0n, chargedPaise: 97_000n, rateLabel: '3%', flags: [] });
    const after = chargeFor(item({ key: 'v2', type: 'VOUCHER', facePaise: 100_000n, committedAt: day(30), brandKey: amazon }), rates);
    expect(after).toMatchObject({ discountPaise: 2_000n, chargedPaise: 98_000n, rateLabel: '2%' });
  });

  it('voucher with no rate for its brand → face value + NO_BRAND_RATE (another brand\'s rate never applies)', () => {
    const rates = [discRate(amazon, 300, day(0))];
    const c = chargeFor(item({ key: 'v', type: 'VOUCHER', facePaise: 50_000n, committedAt: day(5), brandKey: 'brand:flipkart' }), rates);
    expect(c).toMatchObject({ discountPaise: 0n, chargedPaise: 50_000n, flags: ['NO_BRAND_RATE'] });
    const noKey = chargeFor(item({ key: 'v', type: 'VOUCHER', facePaise: 50_000n, committedAt: day(5), brandKey: null }), [discRate('', 300, day(0))]);
    expect(noKey.flags).toEqual(['NO_BRAND_RATE']);
  });

  it('voucher discount committed BEFORE the first rate → face value + flagged', () => {
    const c = chargeFor(item({ key: 'v', type: 'VOUCHER', facePaise: 10_000n, committedAt: day(1), brandKey: amazon }), [discRate(amazon, 300, day(2))]);
    expect(c.chargedPaise).toBe(10_000n);
    expect(c.flags).toEqual(['NO_BRAND_RATE']);
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
  const rates: FundRateRow[] = [feeRate({ effectiveFrom: day(0), rateBps: 1000 }), discRate('brand:amazon', 300, day(0))];

  it('balance = opening + receipts + adjustments − committed − paid; returned nets to zero; running balance', () => {
    const stmt = buildFundStatement({
      rates,
      entries: [
        entry({ id: 'o', kind: 'OPENING_BALANCE', amountPaise: 1_000_000n, date: day(0) }),
        entry({ id: 'r1', kind: 'RECEIPT', amountPaise: 500_000n, date: day(2) }),
        entry({ id: 'a1', kind: 'ADJUSTMENT', amountPaise: -10_000n, date: day(6), note: 'bank charges' }),
      ],
      items: [
        item({ key: 'v-paid', type: 'VOUCHER', facePaise: 100_000n, committedAt: day(1), brandKey: 'brand:amazon', status: 'PAID', paidAt: day(1) }),
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
        item({ key: 'old-returned', type: 'VOUCHER', facePaise: 5_000n, committedAt: day(9), status: 'RETURNED', returnedAt: day(12), brandKey: 'brand:amazon' }),
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

  it('flags: missing brand rate is counted per brand; receivables collected (not credited)', () => {
    const stmt = buildFundStatement({
      rates: [],
      entries: [],
      items: [
        item({ key: 'v1', type: 'VOUCHER', facePaise: 1_000n, committedAt: day(1), brandKey: 'brand:x', brandLabel: 'X' }),
        item({ key: 'v2', type: 'VOUCHER', facePaise: 1_000n, committedAt: day(2), brandKey: 'brand:x', brandLabel: 'X' }),
        item({ key: 'p', type: 'CREDIT_PAYOUT', facePaise: 5_000n, committedAt: day(1), status: 'PAID', paidAt: day(2), receivablePaise: 4_900n }),
      ],
    });
    expect(stmt.flagCounts).toEqual({ NO_BRAND_RATE: 2, NO_FEE_RATE: 1 });
    expect(stmt.brandsWithoutRate).toEqual([{ brandKey: 'brand:x', brandLabel: 'X', count: 2 }]);
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
        item({ key: 'c', type: 'VOUCHER', facePaise: 30_000n, committedAt: day(6), brandKey: 'brand:amazon' }),
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
    reward: { id: 'rw1', name: 'Amazon Pay ₹500', metadata: { hubbleProductId: 'P1' } },
    statusHistory: hist(['CONFIRMED', day(1)]),
    ...o,
  });

  it('voucher never confirmed → not a spend item', () => {
    expect(voucherItem(order({ status: 'CANCELLED', statusHistory: hist(['CANCELLED', day(1)]) }))).toBeNull();
  });

  it('voucher committed at the CONFIRMED history row; DELIVERED → paid at deliveredAt; brand from the Hubble product', () => {
    const it1 = voucherItem(order({ status: 'DELIVERED', deliveredAt: day(2), statusHistory: hist(['DELIVERED', day(2)], ['CONFIRMED', day(1)]) }))!;
    expect(it1).toMatchObject({ status: 'PAID', committedAt: day(1), paidAt: day(2), facePaise: 50_000n, brandKey: 'hubble:P1', type: 'VOUCHER' });
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

  it('brand key: metadata brand > Hubble product > the item itself', () => {
    expect(voucherBrandOf({ id: 'i', name: 'Amazon ₹500', metadata: { brand: ' Amazon ', hubbleProductId: 'P' } })).toEqual({ brandKey: 'brand:amazon', brandLabel: 'Amazon' });
    expect(voucherBrandOf({ id: 'i', name: 'Amazon ₹500', metadata: { hubbleProductId: 'P' } })).toEqual({ brandKey: 'hubble:P', brandLabel: 'Amazon ₹500' });
    expect(voucherBrandOf({ id: 'i', name: 'Manual card', metadata: null })).toEqual({ brandKey: 'item:i', brandLabel: 'Manual card' });
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
    expect(creditItem(entryRow({ status: 'REVERSED', reversalAllocations: [{ state: 'APPLIED_CANCELLED', amountPaise: 100_000n, receivablePaise: 0n, updatedAt: day(4) }] }), vis)).toMatchObject({
      status: 'RETURNED',
      returnedAt: day(4),
    });
    const failed = creditItem(entryRow({ status: 'FAILED' }), vis)!;
    expect(failed.status).toBe('COMMITTED');
    expect(failed.flags).toEqual(['FAILED_AWAITING_REBANK']);
  });

  it('credit payout PAID then reversed → stays paid + receivable (net received; legacy row → gross)', () => {
    const a = creditItem(entryRow({ status: 'PAID', paidAt: day(2), reversalAllocations: [{ state: 'APPLIED_RECEIVABLE', amountPaise: 100_000n, receivablePaise: 98_000n, updatedAt: day(5) }] }), vis)!;
    expect(a).toMatchObject({ status: 'PAID', receivablePaise: 98_000n });
    const legacy = creditItem(entryRow({ status: 'PAID', paidAt: day(2), reversalAllocations: [{ state: 'APPLIED_RECEIVABLE', amountPaise: 100_000n, receivablePaise: 0n, updatedAt: day(5) }] }), vis)!;
    expect(legacy.receivablePaise).toBe(100_000n);
    const released = creditItem(entryRow({ status: 'PAID', paidAt: day(2), reversalAllocations: [{ state: 'RELEASED', amountPaise: 100_000n, receivablePaise: 0n, updatedAt: day(5) }] }), vis)!;
    expect(released.receivablePaise).toBe(0n);
  });

  it('imported vendor history (VENDOR_IMPORT) is not spend from the advance', () => {
    expect(creditItem(entryRow({ batch: { batchCode: 'IMP', sourceKind: 'VENDOR_IMPORT' } }), vis)).toBeNull();
  });

  it('194C TDS recovery → a paid TDS line (PAN masked); negative true-up described as a credit', () => {
    const t = tdsItem({ id: 'r1', panNumber: 'ABCDE1234F', fyLabel: '2026-27', tenantSharePaise: 2_041n, createdAt: day(2) });
    expect(t).toMatchObject({ type: 'TDS_194C', facePaise: 2_041n, status: 'PAID', committedAt: day(2) });
    expect(t.description).toContain('…234F');
    expect(t.description).not.toContain('ABCDE');
    expect(tdsItem({ id: 'r2', panNumber: '__NO_PAN__:OUT7', fyLabel: 'x', tenantSharePaise: -100n, createdAt: day(2) }).description).toContain('true-up');
  });
});

