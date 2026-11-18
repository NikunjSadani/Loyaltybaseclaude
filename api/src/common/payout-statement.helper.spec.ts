/**
 * Payout statement — TDS withheld from a credit payout (owner audit A-M3/B-M1, 2026-11-18).
 * The retailer must see what actually reached them: the NET amount (gross − TDS withheld); a payout
 * fully withheld as TDS shows ₹0 paid with no (fake) UTR — never "Paid ₹X".
 */
import { buildPayoutStatement, type PayoutStatementReader } from './payout-statement.helper';

const entry = (o: Partial<Record<string, unknown>>) => ({
  id: 'e1', period: '2026-05', fieldName: 'Visibility', amountPaise: 500000n, narration: '', status: 'PAID',
  utr: 'UTR123', paidAt: new Date('2026-06-02T00:00:00Z'), createdAt: new Date('2026-05-31T00:00:00Z'), tdsDeductedPaise: 0n,
  ...o,
});

function reader(rows: unknown[]): PayoutStatementReader {
  return {
    outlet: { findMany: async () => [{ outletCode: 'O1' }] },
    payoutTransaction: { findMany: async () => [] },
    creditPayoutEntry: { findMany: async () => rows as never },
  };
}

describe('buildPayoutStatement — TDS withheld', () => {
  it('a payout with no TDS is unchanged (amount = gross, UTR shown)', async () => {
    const [row] = await buildPayoutStatement(reader([entry({})]), 'c', 'p');
    expect(row).toMatchObject({ payoutAmountPaise: 500000, utr: 'UTR123', status: 'PAID' });
    expect(row.tdsWithheldPaise).toBeUndefined();
    expect(row.settledByTds).toBeUndefined();
  });

  it('a PARTLY withheld payout shows the NET received (₹5,000 − ₹500 = ₹4,500) and the TDS taken', async () => {
    const [row] = await buildPayoutStatement(reader([entry({ tdsDeductedPaise: 50000n })]), 'c', 'p');
    expect(row).toMatchObject({ payoutAmountPaise: 450000, grossAmountPaise: 500000, tdsWithheldPaise: 50000, utr: 'UTR123' });
  });

  it('a FULLY withheld payout shows ₹0 paid, the TDS taken, and NO fake UTR', async () => {
    const [row] = await buildPayoutStatement(
      reader([entry({ tdsDeductedPaise: 500000n, utr: 'TDS-WITHHELD-PD-2026-05-001' })]),
      'c',
      'p',
    );
    expect(row).toMatchObject({ payoutAmountPaise: 0, grossAmountPaise: 500000, tdsWithheldPaise: 500000, settledByTds: true });
    expect(row.utr).toBeUndefined();
  });

  it('lifetime totals summed over the rows are the NET received', async () => {
    const rows = await buildPayoutStatement(
      reader([
        entry({ id: 'a' }),
        entry({ id: 'b', tdsDeductedPaise: 50000n }),
        entry({ id: 'c', tdsDeductedPaise: 500000n, utr: 'TDS-WITHHELD-X' }),
      ]),
      'c',
      'p',
    );
    expect(rows.reduce((s, r) => s + r.payoutAmountPaise, 0)).toBe(500000 + 450000 + 0);
  });
});
