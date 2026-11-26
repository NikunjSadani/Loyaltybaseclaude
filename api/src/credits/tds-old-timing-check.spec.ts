/** The one-off READ-ONLY owner check (2026-11-25/26): old-timing 194C TDS rows whose payee has never-paid payouts. */
import { oldTimingTdsCheck } from './tds-old-timing-check';

function db(rec: unknown[], entries: unknown[], outlets: unknown[] = []) {
  return {
    tdsRecoveryEntry: { findMany: jest.fn(async () => rec) },
    outlet: { findMany: jest.fn(async () => outlets) },
    creditPayoutEntry: { findMany: jest.fn(async () => entries) },
    autoInvoice: { findMany: jest.fn(async () => [{ id: 'inv1', invoiceNumber: 'TGSL-TDS-PAN1-202627-001' }]) },
    creditPayoutDownload: { findMany: jest.fn(async () => [{ id: 'd1', downloadCode: 'PD-2026-10-001' }]) },
  } as any;
}
const r1 = { id: 'r1', clientId: 'bajaj', panNumber: 'pan1', fyLabel: '2026-27', tenantSharePaise: 111100n, tdsInvoiceId: 'inv1', downloadId: 'd1', createdAt: new Date() };

describe('oldTimingTdsCheck', () => {
  it('lists only OLD-timing rows (raisedOn NULL) whose payee had FAILED / CANCELLED / REVERSED payouts that FY — read-only', async () => {
    const d = db(
      [r1, { ...r1, id: 'r2', panNumber: 'PAN2', tdsInvoiceId: null, downloadId: null }],
      [
        { clientId: 'bajaj', outletId: 'O1', payeePan: 'PAN1', period: '2026-10', status: 'PAID', amountPaise: 6000000n },
        { clientId: 'bajaj', outletId: 'O1', payeePan: 'PAN1', period: '2026-10', status: 'CANCELLED', amountPaise: 5000000n },
        { clientId: 'bajaj', outletId: 'O2', payeePan: 'PAN2', period: '2026-10', status: 'PAID', amountPaise: 100n },
      ],
    );
    const out = await oldTimingTdsCheck(d, 'bajaj');
    expect(d.tdsRecoveryEntry.findMany.mock.calls[0][0].where).toEqual({ section: 'SEC_194C', raisedOn: null, clientId: 'bajaj' });
    expect(out.rows).toEqual([
      expect.objectContaining({
        recoveryId: 'r1', payee: 'PAN …PAN1', tdsInvoiceNumber: 'TGSL-TDS-PAN1-202627-001', bankFileCode: 'PD-2026-10-001',
        notPaid: { count: 1, paise: 5000000 },
        payouts: { PAID: { count: 1, paise: 6000000 }, CANCELLED: { count: 1, paise: 5000000 } },
      }),
    ]);
    expect(out.limits.length).toBeGreaterThan(0); // what it cannot determine is said on the screen
  });

  it('counts payouts WITHOUT a payee snapshot by the outlet’s current owner, and ANOTHER client’s failed payouts for the same PAN', async () => {
    const d = db(
      [r1],
      [
        // deoleo's pre-snapshot FAILED payout for the same PAN (no payeePan) — resolved via its outlet's current owner.
        { clientId: 'deoleo', outletId: 'D9', payeePan: null, period: '2026-11', status: 'FAILED', amountPaise: 4000000n },
        { clientId: 'bajaj', outletId: 'O1', payeePan: 'PAN1', period: '2026-10', status: 'PAID', amountPaise: 6000000n },
      ],
      [{ clientId: 'deoleo', outletCode: 'D9', partner: { panNumber: 'pan1' } }],
    );
    const out = await oldTimingTdsCheck(d, 'bajaj');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].notPaid).toEqual({ count: 1, paise: 4000000 });
    expect(out.rows[0].notPaidByClient).toEqual({ deoleo: { count: 1, paise: 4000000 } });
  });
});
