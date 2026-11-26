/** The one-off READ-ONLY owner check (2026-11-25): old-timing 194C TDS rows whose payee has never-paid payouts. */
import { oldTimingTdsCheck } from './tds-old-timing-check';

describe('oldTimingTdsCheck', () => {
  const db: any = {
    tdsRecoveryEntry: { findMany: jest.fn() },
    creditPayoutEntry: { findMany: jest.fn() },
    autoInvoice: { findMany: jest.fn(async () => [{ id: 'inv1', invoiceNumber: 'TGSL-TDS-PAN1-202627-001' }]) },
    creditPayoutDownload: { findMany: jest.fn(async () => [{ id: 'd1', downloadCode: 'PD-2026-10-001' }]) },
  };
  it('lists only OLD-timing rows (raisedOn NULL) whose payee had FAILED / CANCELLED / REVERSED payouts that FY — read-only', async () => {
    db.tdsRecoveryEntry.findMany.mockResolvedValue([
      { id: 'r1', clientId: 'bajaj', panNumber: 'pan1', fyLabel: '2026-27', tenantSharePaise: 111100n, tdsInvoiceId: 'inv1', downloadId: 'd1', createdAt: new Date() },
      { id: 'r2', clientId: 'bajaj', panNumber: 'PAN2', fyLabel: '2026-27', tenantSharePaise: 5000n, tdsInvoiceId: null, downloadId: null, createdAt: new Date() },
    ]);
    db.creditPayoutEntry.findMany.mockResolvedValue([
      { clientId: 'bajaj', outletId: 'O1', payeePan: 'PAN1', period: '2026-10', status: 'PAID', amountPaise: 6000000n },
      { clientId: 'bajaj', outletId: 'O1', payeePan: 'PAN1', period: '2026-10', status: 'CANCELLED', amountPaise: 5000000n },
      { clientId: 'bajaj', outletId: 'O2', payeePan: 'PAN2', period: '2026-10', status: 'PAID', amountPaise: 100n },
    ]);
    const out = await oldTimingTdsCheck(db, 'bajaj');
    expect(db.tdsRecoveryEntry.findMany.mock.calls[0][0].where).toEqual({ section: 'SEC_194C', raisedOn: null, clientId: 'bajaj' });
    expect(out).toEqual([
      expect.objectContaining({
        recoveryId: 'r1', payee: 'PAN …PAN1', tdsInvoiceNumber: 'TGSL-TDS-PAN1-202627-001', bankFileCode: 'PD-2026-10-001',
        notPaid: { count: 1, paise: 5000000 },
        payouts: { PAID: { count: 1, paise: 6000000 }, CANCELLED: { count: 1, paise: 5000000 } },
      }),
    ]);
  });
});
