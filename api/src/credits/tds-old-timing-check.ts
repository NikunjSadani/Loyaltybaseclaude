/**
 * One-off, READ-ONLY check for the owner (2026-11-25, "TDS invoice only on success"): the 194C TDS recovery rows raised
 * at the BANK FILE under the old timing (raisedOn NULL) whose payee has payouts that were never paid that financial
 * year (FAILED / CANCELLED / REVERSED) — those rows may include TDS on money that never left. Nothing is changed:
 * existing invoices and recovery rows stay as they are; the owner reviews this list once.
 */
import type { Prisma } from '@prisma/client';
import { fyLabelForPeriod } from '../tds/tds.helpers';

const NO_PAN = '__NO_PAN__';
const NOT_PAID = new Set(['FAILED', 'CANCELLED', 'REVERSED']);

export interface OldTimingRow {
  recoveryId: string;
  clientId: string;
  payee: string;
  fyLabel: string;
  tenantSharePaise: number;
  tdsInvoiceNumber: string | null;
  bankFileCode: string | null;
  recordedAt: string;
  /** The payee's 194C payouts of that FY (this client) by status. */
  payouts: Record<string, { count: number; paise: number }>;
  notPaid: { count: number; paise: number };
}

const keyOfEntry = (payeePan: string | null, outletId: string) => {
  const p = (payeePan ?? '').trim();
  return p && !p.startsWith(NO_PAN) ? p.toUpperCase() : `${NO_PAN}:${outletId}`;
};
const mask = (k: string) => (k.startsWith(NO_PAN) ? `no PAN (outlet ${k.split(':').slice(1).join(':')})` : `PAN …${k.slice(-4)}`);

export async function oldTimingTdsCheck(db: Prisma.TransactionClient, clientId: string | null): Promise<OldTimingRow[]> {
  const rec = await db.tdsRecoveryEntry.findMany({
    where: { section: 'SEC_194C', raisedOn: null, ...(clientId ? { clientId } : {}) },
    select: { id: true, clientId: true, panNumber: true, fyLabel: true, tenantSharePaise: true, tdsInvoiceId: true, downloadId: true, createdAt: true },
    orderBy: [{ fyLabel: 'desc' }, { createdAt: 'asc' }],
  });
  if (rec.length === 0) return [];
  const clients = [...new Set(rec.map((r) => r.clientId))];
  const entries = await db.creditPayoutEntry.findMany({
    where: { clientId: { in: clients }, tdsSection: 'SEC_194C', NOT: { payeePan: null } },
    select: { clientId: true, outletId: true, payeePan: true, period: true, status: true, amountPaise: true },
  });
  const byKey = new Map<string, Array<(typeof entries)[number]>>();
  for (const e of entries) {
    const k = `${e.clientId}|${keyOfEntry(e.payeePan, e.outletId)}|${fyLabelForPeriod(e.period)}`;
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  const [invoices, runs] = await Promise.all([
    db.autoInvoice.findMany({ where: { id: { in: rec.map((r) => r.tdsInvoiceId).filter((x): x is string => !!x) } }, select: { id: true, invoiceNumber: true } }),
    db.creditPayoutDownload.findMany({ where: { id: { in: rec.map((r) => r.downloadId).filter((x): x is string => !!x) } }, select: { id: true, downloadCode: true } }),
  ]);
  const invNo = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));
  const runCode = new Map(runs.map((d) => [d.id, d.downloadCode]));
  const out: OldTimingRow[] = [];
  for (const r of rec) {
    const k = r.panNumber.trim().startsWith(NO_PAN) ? r.panNumber.trim() : r.panNumber.trim().toUpperCase();
    const mine = byKey.get(`${r.clientId}|${k}|${r.fyLabel}`) ?? [];
    const payouts: OldTimingRow['payouts'] = {};
    const notPaid = { count: 0, paise: 0 };
    for (const e of mine) {
      const s = String(e.status);
      const b = (payouts[s] ??= { count: 0, paise: 0 });
      b.count += 1;
      b.paise += Number(e.amountPaise);
      if (NOT_PAID.has(s)) { notPaid.count += 1; notPaid.paise += Number(e.amountPaise); }
    }
    if (notPaid.count === 0) continue;
    out.push({
      recoveryId: r.id,
      clientId: r.clientId,
      payee: mask(k),
      fyLabel: r.fyLabel,
      tenantSharePaise: Number(r.tenantSharePaise),
      tdsInvoiceNumber: r.tdsInvoiceId ? invNo.get(r.tdsInvoiceId) ?? null : null,
      bankFileCode: r.downloadId ? runCode.get(r.downloadId) ?? null : null,
      recordedAt: r.createdAt.toISOString(),
      payouts,
      notPaid,
    });
  }
  return out;
}
