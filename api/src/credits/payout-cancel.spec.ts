/**
 * Payout cancellation (owner 2026-11-25) — the money core against an in-memory fake of the tables it touches.
 * Covers: unpaid + failed happy paths, whole-request refusal, role / assumed-tenant gate, tenant scoping, every FAILED
 * side effect (DEDUCT withholding, TDS ledger, TDS credit, 194C gross-up / no-PAN recovery), reversal holds, the SERVICE
 * invoice void (+ GST holdback) and its refusals, and the audit row.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { applyCancellation, assertGifsyAssumed, evaluateCancellation, normaliseReason, type CancelItem } from './payout-cancel';

type Row = Record<string, any>;

const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);

function entry(over: Row = {}): Row {
  return {
    id: 'e1', clientId: 'bajaj', batchId: 'b1', outletId: 'O1', outletName: 'Outlet One', fieldId: 'f1', fieldName: 'Visibility',
    period: periodNow(), amountPaise: 10000n, status: 'PENDING', downloadId: null, failureReason: null, attemptedAt: null,
    autoInvoiceId: null, tdsSection: 'SEC_194R', tdsDeductedPaise: 0n, payeePan: null, createdAt: daysAgo(5),
    batch: { batchCode: 'CB-1' }, download: null, ...over,
  };
}
function periodNow(): string {
  const d = new Date(NOW);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface World {
  entries: Row[];
  allocations?: Row[];
  reversals?: Row[];
  ledger?: Row[];
  creditApps?: Row[];
  recovery?: Row[];
  invoices?: Row[];
  gst?: Row[];
  visibilityFieldIds?: string[];
}

function inList(v: unknown, f: any): boolean {
  if (f === undefined) return true;
  if (f && typeof f === 'object' && !(f instanceof Date)) {
    if ('in' in f) return f.in.includes(v);
    if ('not' in f) return v !== f.not;
    if ('gte' in f) return (v as Date).getTime() >= f.gte.getTime();
  }
  return v === f;
}

function fake(w: World) {
  const audits: Row[] = [];
  const match = (row: Row, where: Row) => Object.entries(where).every(([k, f]) => (k === 'OR' ? (f as Row[]).some((o) => match(row, o)) : inList(row[k], f)));
  const tx: any = {
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 1),
    creditPayoutEntry: {
      findMany: jest.fn(async ({ where }: any) => w.entries.filter((e) => match(e, where))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = w.entries.filter((e) => match(e, where));
        hit.forEach((e) => Object.assign(e, data));
        return { count: hit.length };
      }),
    },
    payoutReversalAllocation: { findMany: jest.fn(async ({ where }: any) => (w.allocations ?? []).filter((a) => match(a, where))) },
    creditReversal: { findMany: jest.fn(async ({ where }: any) => (w.reversals ?? []).filter((r) => match(r, where))) },
    tdsDeductionEntry: { findMany: jest.fn(async ({ where }: any) => (w.ledger ?? []).filter((r) => match(r, where))) },
    tdsCreditApplication: { findMany: jest.fn(async ({ where }: any) => (w.creditApps ?? []).filter((r) => match(r, where))) },
    tdsRecoveryEntry: { findMany: jest.fn(async ({ where }: any) => (w.recovery ?? []).filter((r) => match(r, where))) },
    autoInvoice: {
      findMany: jest.fn(async ({ where }: any) => (w.invoices ?? []).filter((r) => match(r, where))),
      findFirst: jest.fn(async ({ where }: any) => (w.invoices ?? []).find((r) => match(r, where)) ?? null),
      count: jest.fn(async ({ where }: any) => (w.invoices ?? []).filter((r) => match(r, where)).length),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `new-${(w.invoices ?? []).length + 1}`, voidedAt: null, lockedAt: null, ...data };
        (w.invoices ??= []).push(row);
        return { id: row.id };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = (w.invoices ?? []).filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    gstReimbursement: {
      findMany: jest.fn(async ({ where }: any) => (w.gst ?? []).filter((r) => match(r, where))),
      create: jest.fn(async ({ data }: any) => { (w.gst ??= []).push(data); return data; }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = (w.gst ?? []).filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    auditLog: { create: jest.fn(async ({ data }: any) => { audits.push(data); return data; }) },
    creditField: { findMany: jest.fn(async () => (w.visibilityFieldIds ?? []).map((id) => ({ id }))) },
  };
  return { tx, audits };
}

const item = (id: string, expectedStatus: 'PENDING' | 'FAILED', paise: bigint): CancelItem => ({ id, expectedStatus, expectedAmountPaise: paise });
const run = (tx: any, items: CancelItem[], kind?: 'UNPAID' | 'FAILED') =>
  applyCancellation(tx, { clientId: 'bajaj', actorId: 'gifsy-admin-1', reason: 'Wrong amount uploaded', items, source: 'SCREEN', kind });

async function refusalOf(p: Promise<unknown>): Promise<Array<{ entryId: string; code: string }>> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictException);
    return ((e as ConflictException).getResponse() as any).details.blocked;
  }
  throw new Error('expected a refusal');
}

describe('who may cancel', () => {
  it('only a GIFSY_ADMIN working inside a client', () => {
    expect(() => assertGifsyAssumed({ role: 'CLIENT_ADMIN', clientId: 'bajaj', sub: 'u', phone: '', name: '' } as any)).toThrow(ForbiddenException);
    expect(() => assertGifsyAssumed({ role: 'GIFSY_STAFF', clientId: 'bajaj', sub: 'u', phone: '', name: '', assumed: true } as any)).toThrow(ForbiddenException);
    expect(() => assertGifsyAssumed({ role: 'GIFSY_ADMIN', clientId: 'gifsy', sub: 'u', phone: '', name: '' } as any)).toThrow(/Open the client first/);
    expect(() => assertGifsyAssumed({ role: 'GIFSY_ADMIN', clientId: 'bajaj', sub: 'u', phone: '', name: '', assumed: true } as any)).not.toThrow();
  });
  it('a reason is mandatory', () => {
    expect(() => normaliseReason('   ')).toThrow(/reason is required/);
    expect(normaliseReason('  dup upload ')).toBe('dup upload');
  });
});

describe('cancel unpaid', () => {
  it('happy path: PENDING never-banked rows → CANCELLED with who/when/why + one audit row per upload', async () => {
    const w: World = { entries: [entry({ id: 'e1' }), entry({ id: 'e2', batchId: 'b2', batch: { batchCode: 'CB-2' }, amountPaise: 2500n })] };
    const { tx, audits } = fake(w);
    const res = await run(tx, [item('e1', 'PENDING', 10000n), item('e2', 'PENDING', 2500n)], 'UNPAID');
    expect(res.cancelled.map((r) => r.entryId).sort()).toEqual(['e1', 'e2']);
    expect(res.totals.all).toEqual({ count: 2, paise: 12500 });
    for (const e of w.entries) {
      expect(e.status).toBe('CANCELLED');
      expect(e.cancelledById).toBe('gifsy-admin-1');
      expect(e.cancelReason).toBe('Wrong amount uploaded');
      expect(e.cancelledAt).toBeInstanceOf(Date);
    }
    // Guarded write: only PENDING rows never in a bank file.
    expect(tx.creditPayoutEntry.updateMany.mock.calls[0][0].where).toMatchObject({ status: 'PENDING', downloadId: null, clientId: 'bajaj' });
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.entityId).sort()).toEqual(['b1', 'b2']);
    expect(audits[0]).toMatchObject({ entityType: 'CREDIT_PAYOUT_CANCELLATION', actorId: 'gifsy-admin-1', action: 'UPDATE' });
    expect(audits[0].metadata).toMatchObject({ event: 'PAYOUTS_CANCELLED', reason: 'Wrong amount uploaded', source: 'SCREEN' });
    // Rows locked (batches → entries) before anything is read for the decision.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('refuses the WHOLE request when any row is not cancellable — nothing is written', async () => {
    const w: World = {
      entries: [
        entry({ id: 'e1' }),
        entry({ id: 'e2', status: 'PROCESSING', downloadId: 'd1', download: { downloadCode: 'PD-1' } }),
        entry({ id: 'e3', status: 'PAID' }),
      ],
    };
    const { tx, audits } = fake(w);
    const blocked = await refusalOf(run(tx, [item('e1', 'PENDING', 10000n), item('e2', 'PENDING', 10000n), item('e3', 'PENDING', 10000n)]));
    expect(blocked.map((b) => [b.entryId, b.code])).toEqual([['e2', 'IN_BANK_FILE'], ['e3', 'PAID']]);
    expect(tx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
    expect(w.entries[0].status).toBe('PENDING');
  });

  it('refuses a row whose amount or status changed since the admin looked', async () => {
    const w: World = { entries: [entry({ id: 'e1', amountPaise: 12000n }), entry({ id: 'e2', status: 'FAILED' })] };
    const { tx } = fake(w);
    const blocked = await refusalOf(run(tx, [item('e1', 'PENDING', 10000n), item('e2', 'PENDING', 10000n)]));
    expect(blocked.map((b) => b.code)).toEqual(['AMOUNT_CHANGED', 'STATUS_CHANGED']);
  });

  it('assumed-tenant scoping: another client’s row is NOT FOUND (never touched)', async () => {
    const w: World = { entries: [entry({ id: 'x1', clientId: 'deoleo' })] };
    const { tx } = fake(w);
    const blocked = await refusalOf(run(tx, [item('x1', 'PENDING', 10000n)]));
    expect(blocked).toEqual([expect.objectContaining({ entryId: 'x1', code: 'NOT_FOUND' })]);
    expect(tx.creditPayoutEntry.findMany.mock.calls.every((c: any[]) => c[0].where.clientId === 'bajaj')).toBe(true);
    expect(w.entries[0].status).toBe('PENDING');
  });

  it('a row held by a pending reversal (reserved, or a pending request for the same outlet+field) is refused', async () => {
    const w: World = {
      entries: [entry({ id: 'e1' }), entry({ id: 'e2', outletId: 'O2' })],
      allocations: [{ payoutEntryId: 'e1', state: 'RESERVED' }],
      reversals: [{ clientId: 'bajaj', awardType: 'PAYOUT', status: 'PENDING_GIFSY', batchId: 'b1', outletId: 'O2', fieldId: 'f1' }],
    };
    const { tx } = fake(w);
    const blocked = await refusalOf(run(tx, [item('e1', 'PENDING', 10000n), item('e2', 'PENDING', 10000n)]));
    expect(blocked.map((b) => b.code)).toEqual(['RESERVED_BY_REVERSAL', 'PENDING_REVERSAL']);
  });

  it('the screen action refuses rows of the other kind up front', async () => {
    const { tx } = fake({ entries: [entry({ id: 'e1', status: 'FAILED' })] });
    await expect(run(tx, [item('e1', 'FAILED', 10000n)], 'UNPAID')).rejects.toThrow(/not unpaid — use the other action/);
  });
});

describe('cancel failed — bank-file side effects', () => {
  const failed = (over: Row = {}) =>
    entry({ status: 'FAILED', downloadId: 'd1', download: { downloadCode: 'PD-1' }, failureReason: 'Account closed', attemptedAt: daysAgo(1), ...over });

  it('a 194R / DEDUCT failed row (withholding already offset at FAILED) cancels cleanly and keeps its bank-file history', async () => {
    const w: World = {
      entries: [failed({ id: 'f1', tdsSection: 'SEC_194R', payeePan: 'ABCDE1234F' })],
      ledger: [{ creditPayoutEntryId: 'f1', tdsDeductedThisPaise: 1000n }, { creditPayoutEntryId: 'f1', tdsDeductedThisPaise: -1000n }],
      creditApps: [{ payoutEntryId: 'f1', releasedAt: daysAgo(1) }],
    };
    const { tx } = fake(w);
    const res = await run(tx, [item('f1', 'FAILED', 10000n)], 'FAILED');
    expect(res.cancelled).toHaveLength(1);
    const e = w.entries[0];
    expect(e.status).toBe('CANCELLED');
    // History stays: bank file, failure reason, attempt date, payee snapshot.
    expect(e).toMatchObject({ downloadId: 'd1', failureReason: 'Account closed', payeePan: 'ABCDE1234F' });
    expect(tx.creditPayoutEntry.updateMany.mock.calls[0][0].where).toMatchObject({ status: 'FAILED' });
  });

  it.each([
    ['TDS_WITHHELD', { tdsDeductedPaise: 500n }, {}],
    ['TDS_LEDGER_OPEN', {}, { ledger: [{ creditPayoutEntryId: 'f1', tdsDeductedThisPaise: 500n }] }],
    ['TDS_CREDIT_APPLIED', {}, { creditApps: [{ payoutEntryId: 'f1', releasedAt: null }] }],
  ])('refuses (never leaves silently) when %s', async (code, over, extra) => {
    const { tx } = fake({ entries: [failed({ id: 'f1', ...over })], ...extra } as World);
    const blocked = await refusalOf(run(tx, [item('f1', 'FAILED', 10000n)]));
    expect(blocked.map((b) => b.code)).toEqual([code]);
  });

  it('194C gross-up / no-PAN: refused when TDS recovery was recorded for the payee this FY since the row was made', async () => {
    const fy = (() => { const d = new Date(NOW); const m = d.getUTCMonth() + 1; const y = m >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; })();
    const w: World = {
      entries: [
        failed({ id: 'g1', tdsSection: 'SEC_194C', payeePan: 'pqrst9876k' }),
        failed({ id: 'n1', outletId: 'O9', tdsSection: 'SEC_194C', payeePan: '__NO_PAN__:p9' }),
        failed({ id: 'ok', outletId: 'O7', tdsSection: 'SEC_194C', payeePan: 'ZZZZZ1111Z' }),
      ],
      recovery: [
        // Old timing (raised at the bank file, raisedOn NULL) — may hold the failed payout's base.
        { clientId: 'other-client', section: 'SEC_194C', panNumber: 'PQRST9876K', fyLabel: fy, createdAt: daysAgo(2), raisedOn: null },
        { clientId: 'bajaj', section: 'SEC_194C', panNumber: '__NO_PAN__:O9', fyLabel: fy, createdAt: daysAgo(2), raisedOn: null },
        // Recorded BEFORE this row existed → it cannot include this row's base.
        { clientId: 'bajaj', section: 'SEC_194C', panNumber: 'ZZZZZ1111Z', fyLabel: fy, createdAt: daysAgo(30), raisedOn: null },
        // New timing (raised when OTHER payouts were PAID) — never includes a failed payout → never blocks.
        { clientId: 'bajaj', section: 'SEC_194C', panNumber: 'ZZZZZ1111Z', fyLabel: fy, createdAt: daysAgo(1), raisedOn: 'PAID' },
      ],
    };
    const { tx } = fake(w);
    const ev = await evaluateCancellation(tx, 'bajaj', [item('g1', 'FAILED', 10000n), item('n1', 'FAILED', 10000n), item('ok', 'FAILED', 10000n)]);
    expect(ev.blocked.map((b) => [b.entryId, b.code])).toEqual([['g1', 'GROSS_UP_TDS_RECORDED'], ['n1', 'GROSS_UP_TDS_RECORDED']]);
    expect(ev.blocked[0].reason).toMatch(/194C TDS/);
    expect(ev.ok.map((r) => r.entryId)).toEqual(['ok']);
  });
});

describe('self-billed SERVICE invoice', () => {
  const inv = (over: Row = {}) => ({ id: 'i1', clientId: 'bajaj', invoiceNumber: 'TGSL-VIS-O1-202611-1', outletCode: 'O1', period: periodNow(), status: 'GENERATED', invoiceKind: 'SERVICE', voidedAt: null, lockedAt: null, totalPaise: 11800n, ...over });

  it('voided in the same transaction when every payout on it is cancelled; its HELD GST becomes VOID', async () => {
    const w: World = {
      entries: [entry({ id: 'e1', autoInvoiceId: 'i1' }), entry({ id: 'e2', autoInvoiceId: 'i1', fieldId: 'f2' }), entry({ id: 'e3', autoInvoiceId: 'i1', status: 'REVERSED' })],
      invoices: [inv()],
      gst: [{ autoInvoiceId: 'i1', status: 'HELD', gstPaise: 1800n }],
    };
    const { tx, audits } = fake(w);
    const res = await run(tx, [item('e1', 'PENDING', 10000n), item('e2', 'PENDING', 10000n)]);
    expect(res.invoicesVoided).toEqual([expect.objectContaining({ id: 'i1', gstHeldPaise: 1800 })]);
    expect(w.invoices![0]).toMatchObject({ status: 'VOID', voidedById: 'gifsy-admin-1' });
    expect(w.invoices![0].voidReason).toMatch(/Wrong amount uploaded/);
    expect(w.gst![0].status).toBe('VOID');
    expect(audits[0].metadata.invoicesVoided).toHaveLength(1);
  });

  describe('an invoice made by the manual "Generate invoices" run (rows NOT linked to it)', () => {
    const vis = (over: Row = {}) => entry({ fieldId: 'f-vis', tdsSection: 'SEC_194C', ...over });
    it('is voided (+ HELD GST) when every visibility payout of its outlet + month is being cancelled', async () => {
      const w: World = {
        entries: [vis({ id: 'v1' }), vis({ id: 'v2', fieldId: 'f-vis' }), entry({ id: 'x', fieldId: 'f-incentive' })],
        invoices: [inv({ id: 'm1', invoiceNumber: 'TGSL-VIS-O1-MANUAL' })],
        gst: [{ autoInvoiceId: 'm1', status: 'HELD', gstPaise: 1800n }],
        visibilityFieldIds: ['f-vis'],
      };
      const { tx, audits } = fake(w);
      const res = await run(tx, [item('v1', 'PENDING', 10000n), item('v2', 'PENDING', 10000n)]);
      expect(res.invoicesVoided.map((i) => i.id)).toEqual(['m1']);
      // The audit row / history name the manual-path invoice (same covers() test as the void plan).
      expect(audits[0].metadata.invoicesVoided).toEqual([expect.objectContaining({ id: 'm1', entryIds: ['v1', 'v2'] })]);
      expect(w.invoices![0].status).toBe('VOID');
      expect(w.gst![0].status).toBe('VOID');
      // The invoice row was locked before the decision (batches → entries → invoices).
      expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    });
    it('owner decision 2026-11-26: when another visibility payout of that outlet + month stays payable, the old invoice is VOIDED and a FRESH one issued for what stays — recorded in the audit row', async () => {
      const w: World = {
        entries: [
          vis({ id: 'v1' }),
          vis({ id: 'v2', batchId: 'b2', status: 'PROCESSING', downloadId: 'd1', amountPaise: 25000n }),
        ],
        invoices: [inv({ id: 'm1', invoiceNumber: 'TGSL-VIS-O1-MANUAL', partnerId: 'p1', snapshot: { gstRegistrationType: 'REGULAR', retailerGstin: '19ABCDE1234F1Z5' } })],
        gst: [{ autoInvoiceId: 'm1', status: 'HELD', gstPaise: 6300n }],
        visibilityFieldIds: ['f-vis'],
      };
      const { tx, audits } = fake(w);
      const res = await run(tx, [item('v1', 'PENDING', 10000n)]);
      // Old invoice voided (+ its HELD GST), a fresh one for the ₹250 that stays (GST recomputed, own HELD row).
      expect(w.invoices![0]).toMatchObject({ status: 'VOID' });
      expect(w.invoices![0].voidReason).toMatch(/Re-issued without/);
      const fresh = w.invoices![1];
      expect(fresh).toMatchObject({ status: 'GENERATED', invoiceKind: 'SERVICE', outletCode: 'O1', subtotalPaise: 25000n, gstPaise: 4500n });
      expect(fresh.invoiceNumber).not.toBe('TGSL-VIS-O1-MANUAL');
      expect(w.gst!.map((g) => g.status)).toEqual(['VOID', 'HELD']);
      // The remaining row is relinked by the reviewed raw UPDATE (no updatedAt bump).
      expect(JSON.stringify(tx.$executeRaw.mock.calls)).toContain('v2');
      expect(res.invoicesReissued).toEqual([expect.objectContaining({ voidedNumber: 'TGSL-VIS-O1-MANUAL', newNumber: fresh.invoiceNumber, remainingEntryIds: ['v2'], basePaise: 25000 })]);
      expect(audits[0].metadata.invoicesVoided.map((i: any) => i.id)).toEqual(['m1']);
      expect(audits[0].metadata.invoicesReissued).toHaveLength(1);
    });
    it('a non-visibility payout of the same outlet + month is not covered by the invoice (no void, no refusal)', async () => {
      const w: World = { entries: [entry({ id: 'x', fieldId: 'f-incentive' })], invoices: [inv({ id: 'm1' })], visibilityFieldIds: ['f-vis'] };
      const { tx } = fake(w);
      const res = await run(tx, [item('x', 'PENDING', 10000n)]);
      expect(res.invoicesVoided).toEqual([]);
      expect(w.invoices![0].status).toBe('GENERATED');
    });
  });

  it.each([
    ['INVOICE_LOCKED', [inv({ lockedAt: daysAgo(1) })], [], []],
    ['GST_RELEASED', [inv()], [{ autoInvoiceId: 'i1', status: 'RELEASED', gstPaise: 1800n }], []],
  ])('refuses when the invoice cannot be voided (%s) — nothing cancelled, invoice untouched', async (code, invoices, gst, others) => {
    const w: World = { entries: [entry({ id: 'e1', autoInvoiceId: 'i1' }), ...(others as Row[])], invoices: invoices as Row[], gst: gst as Row[] };
    const { tx } = fake(w);
    const blocked = await refusalOf(run(tx, [item('e1', 'PENDING', 10000n)]));
    expect(blocked.map((b) => b.code)).toEqual([code]);
    expect(w.invoices![0].status).not.toBe('VOID');
    expect(w.entries[0].status).toBe('PENDING');
  });
});
