import { BadRequestException } from '@nestjs/common';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import type { XlsxStreamWriter } from '../common/xlsx-stream';
import { EXPORT_KINDS } from '../exports/kinds';
import { FUND_RECONCILIATION_KIND } from './fund-reconciliation.kind';

/** In-memory XlsxStreamWriter: sheet name → [headers, ...rows]. */
function memWriter() {
  const sheets = new Map<string, unknown[][]>();
  let total = 0;
  const w: XlsxStreamWriter = {
    async addSheet(name, headers) {
      const rows: unknown[][] = [[...headers]];
      sheets.set(name, rows);
      return {
        async addRow(cells) {
          rows.push([...cells]);
          total += 1;
        },
        get rowCount() {
          return rows.length - 1;
        },
      };
    },
    async finish() {},
    get rowCount() {
      return total;
    },
  };
  return { w, sheets };
}

const day = (n: number) => new Date(Date.now() - (30 - n) * 86_400_000);

function prisma() {
  return {
    fundReceipt: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'o', entryType: 'OPENING_BALANCE', receiptNumber: 'FO-1', amountPaise: 1_000_000n, receivedAt: day(0), paymentMode: 'OPENING_BALANCE', referenceNumber: null, bankName: null, notes: null, reason: null, createdByUserId: 'g', createdAt: day(0) },
        { id: 'r', entryType: 'RECEIPT', receiptNumber: 'FR-1', amountPaise: 500_000n, receivedAt: day(5), paymentMode: 'NEFT', referenceNumber: 'UTR9', bankName: 'HDFC', notes: null, reason: null, createdByUserId: 'g', createdAt: day(5) },
      ]),
    },
    fundRate: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'f', kind: 'AGENCY_FEE', rewardId: null, rewardLabel: null, feeType: 'PERCENT', rateBps: 500, flatPaise: null, effectiveFrom: day(0), note: null, repricedLines: 3, repriceDeltaPaise: -150n, repricedFrom: day(0), createdById: 'g', createdAt: day(0) },
      ]),
    },
    redemptionOrder: { findMany: jest.fn().mockResolvedValue([]) },
    payoutTransaction: {
      findMany: jest.fn().mockResolvedValue([
        { id: 't1', amountPaise: 100_000n, status: 'SUCCESS', payoutMode: 'UPI', createdAt: day(6), completedAt: day(7), reversedAt: null, updatedAt: day(7), providerRefId: 'UTRX', redemptionOrderId: null, batch: null },
      ]),
    },
    creditPayoutEntry: { findMany: jest.fn().mockResolvedValue([]) },
    creditField: { findMany: jest.fn().mockResolvedValue([]) },
    creditReversal: { findMany: jest.fn().mockResolvedValue([]) },
    tdsRecoveryEntry: { findMany: jest.fn().mockResolvedValue([]) },
    fundSettings: { findUnique: jest.fn().mockResolvedValue({ lowBalanceThresholdPaise: 2_000_000n }) },
  };
}

const clientAdmin: JwtPayload = { sub: 'c', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };

describe('export kind fund-reconciliation', () => {
  it('is registered once, for GIFSY_ADMIN + CLIENT_ADMIN with payouts:read, streaming instantly', () => {
    expect(EXPORT_KINDS.get('fund-reconciliation')).toBe(FUND_RECONCILIATION_KIND);
    expect(FUND_RECONCILIATION_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'payouts:read' });
  });

  it('refuses an un-assumed Gifsy owner and bad dates', () => {
    expect(() => FUND_RECONCILIATION_KIND.parseParams({}, { ...clientAdmin, role: 'GIFSY_ADMIN', clientId: 'gifsy' })).toThrow(BadRequestException);
    expect(() => FUND_RECONCILIATION_KIND.parseParams({ from: '2026-02-30' }, clientAdmin)).toThrow(BadRequestException);
    expect(() => FUND_RECONCILIATION_KIND.parseParams({ from: '2026-03-02', to: '2026-03-01' }, clientAdmin)).toThrow(BadRequestException);
    expect(FUND_RECONCILIATION_KIND.parseParams({}, clientAdmin)).toEqual({ from: null, to: null });
  });

  it('writes Summary · Statement · Receipts · Rates · About from the SAME engine, scoped to ctx.clientId', async () => {
    const db = prisma();
    const { w, sheets } = memWriter();
    await FUND_RECONCILIATION_KIND.run(
      { prisma: db as never, moduleRef: {} as never, clientId: 'deoleo', user: clientAdmin, now: new Date() },
      { from: null, to: null },
      w,
    );
    expect([...sheets.keys()]).toEqual(['Summary', 'Statement', 'Receipts', 'Rates', 'About']);
    const stmt = sheets.get('Statement')!;
    const head = stmt[0] as string[];
    const bal = head.indexOf('Balance (₹)');
    // opening 10,000 → charge 1,050 (₹1,000 + 5%) → receipt 5,000 ... chronological; last balance = 13,950.
    // + the D1 information line for the recorded back-dated fee (amount 0, balance unchanged).
    expect(stmt.slice(1).map((r) => r[bal])).toEqual([10_000, 10_000, 15_000, 13_950]);
    const entry = head.indexOf('Entry');
    expect(stmt[2][entry]).toBe('Rate change (information)');
    const summary = sheets.get('Summary')!;
    const balanceRow = summary.find((r) => r[1] === 'Balance (= available)')!;
    expect(balanceRow[3]).toBe(13_950);
    expect(summary.find((r) => r[1] === 'Low-balance threshold')![4]).toMatch(/LOW/);
    expect(sheets.get('Receipts')!.length).toBe(3);
    expect(sheets.get('Rates')!.slice(1)[0]).toContain('5%');
    const about = sheets.get('About')!.map((r) => String(r[1])).join(' ');
    expect(about).not.toMatch(/never rewritten/);
    expect(about).not.toMatch(/Hubble/);
    for (const m of [db.fundReceipt.findMany, db.fundRate.findMany, db.creditPayoutEntry.findMany, db.tdsRecoveryEntry.findMany]) {
      expect(m.mock.calls[0][0].where.clientId).toBe('deoleo');
    }
    expect(db.payoutTransaction.findMany.mock.calls[0][0].where.partner).toEqual({ clientId: 'deoleo' });
  });
});
