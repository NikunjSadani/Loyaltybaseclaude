/**
 * One-off, READ-ONLY check for the owner (2026-11-25, "TDS invoice only on success"): the 194C TDS recovery rows raised
 * at the BANK FILE under the old timing (raisedOn NULL) whose payee has payouts that were never paid that financial
 * year (FAILED / CANCELLED / REVERSED) — in ANY client (a PAN's 194C TDS is shared across clients, so another client's
 * failed payout can sit inside this client's recovery). Nothing is changed: existing invoices and recovery rows stay.
 *
 * Payee of a payout = its payee snapshot (taken at the bank file); a row without one (before the snapshot existed) is
 * resolved the way the engine does — the outlet's CURRENT owner PAN, else the outlet's no-PAN key. What it cannot
 * determine is returned in `limits` (shown on the screen).
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
  /** The payee's 194C payouts of that FY, every client, by status. */
  payouts: Record<string, { count: number; paise: number }>;
  notPaid: { count: number; paise: number };
  /** Never-paid payouts by client (another client's failed payout can be inside this row). */
  notPaidByClient: Record<string, { count: number; paise: number }>;
}

export interface OldTimingResult {
  rows: OldTimingRow[];
  limits: string[];
}

const mask = (k: string) => (k.startsWith(NO_PAN) ? `no PAN (outlet ${k.split(':').slice(1).join(':')})` : `PAN …${k.slice(-4)}`);
const keyOfRecovery = (p: string) => (p.trim().startsWith(NO_PAN) ? p.trim() : p.trim().toUpperCase());

export async function oldTimingTdsCheck(db: Prisma.TransactionClient, clientId: string | null): Promise<OldTimingResult> {
  const limits = [
    'TDS rows recorded before 24 Nov 2026 carry no bank-file link, so the check cannot tell which payouts a row actually included — it lists the payee’s whole financial year.',
    'A payout recorded before the payee snapshot existed is matched by its outlet’s CURRENT owner PAN; if the PAN changed since, it may be matched to the wrong payee.',
  ];
  const rec = await db.tdsRecoveryEntry.findMany({
    where: { section: 'SEC_194C', raisedOn: null, ...(clientId ? { clientId } : {}) },
    select: { id: true, clientId: true, panNumber: true, fyLabel: true, tenantSharePaise: true, tdsInvoiceId: true, downloadId: true, createdAt: true },
    orderBy: [{ fyLabel: 'desc' }, { createdAt: 'asc' }],
  });
  if (rec.length === 0) return { rows: [], limits };
  const keys = [...new Set(rec.map((r) => keyOfRecovery(r.panNumber)))];
  const pans = keys.filter((k) => !k.startsWith(NO_PAN));
  const noPanOutlets = keys.filter((k) => k.startsWith(NO_PAN)).map((k) => k.split(':').slice(1).join(':'));

  // Outlets whose CURRENT owner has one of these PANs (any client), and the no-PAN outlets' own rows.
  const owned = await db.outlet.findMany({
    where: { OR: [...(pans.length ? [{ partner: { panNumber: { in: pans }, isParent: false } }] : []), ...(noPanOutlets.length ? [{ outletCode: { in: noPanOutlets } }] : [])] },
    select: { clientId: true, outletCode: true, partner: { select: { panNumber: true } } },
  });
  const currentKey = new Map<string, string>();
  for (const o of owned ?? []) {
    const p = (o.partner?.panNumber ?? '').trim().toUpperCase();
    currentKey.set(`${o.clientId}|${o.outletCode}`, p ? p : `${NO_PAN}:${o.outletCode}`);
  }
  const entries = await db.creditPayoutEntry.findMany({
    where: {
      tdsSection: 'SEC_194C',
      OR: [
        ...(pans.length ? [{ payeePan: { in: pans } }] : []),
        ...(noPanOutlets.length ? [{ outletId: { in: noPanOutlets } }] : []),
        ...(owned?.length ? [{ payeePan: null, OR: owned.map((o) => ({ clientId: o.clientId, outletId: o.outletCode })) }] : []),
      ],
    },
    select: { clientId: true, outletId: true, payeePan: true, period: true, status: true, amountPaise: true },
  });
  const keyOfEntry = (e: (typeof entries)[number]): string | null => {
    const p = (e.payeePan ?? '').trim();
    if (p) return p.startsWith(NO_PAN) ? `${NO_PAN}:${e.outletId}` : p.toUpperCase();
    return currentKey.get(`${e.clientId}|${e.outletId}`) ?? null; // pre-snapshot row → the current owner (engine rule)
  };
  let unresolved = 0;
  const byKey = new Map<string, Array<(typeof entries)[number]>>();
  for (const e of entries) {
    const k = keyOfEntry(e);
    if (!k) { unresolved++; continue; }
    // A no-PAN key is per (client, outlet); a PAN key spans every client.
    const kk = `${k.startsWith(NO_PAN) ? `${e.clientId}|` : ''}${k}|${fyLabelForPeriod(e.period)}`;
    byKey.set(kk, [...(byKey.get(kk) ?? []), e]);
  }
  if (unresolved > 0) limits.push(`${unresolved} payout row(s) could not be matched to a payee (their outlet has no owner on file) and are not counted.`);

  const [invoices, runs] = await Promise.all([
    db.autoInvoice.findMany({ where: { id: { in: rec.map((r) => r.tdsInvoiceId).filter((x): x is string => !!x) } }, select: { id: true, invoiceNumber: true } }),
    db.creditPayoutDownload.findMany({ where: { id: { in: rec.map((r) => r.downloadId).filter((x): x is string => !!x) } }, select: { id: true, downloadCode: true } }),
  ]);
  const invNo = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));
  const runCode = new Map(runs.map((d) => [d.id, d.downloadCode]));
  const rows: OldTimingRow[] = [];
  for (const r of rec) {
    const k = keyOfRecovery(r.panNumber);
    const mine = byKey.get(`${k.startsWith(NO_PAN) ? `${r.clientId}|` : ''}${k}|${r.fyLabel}`) ?? [];
    const payouts: OldTimingRow['payouts'] = {};
    const notPaid = { count: 0, paise: 0 };
    const notPaidByClient: OldTimingRow['notPaidByClient'] = {};
    for (const e of mine) {
      const s = String(e.status);
      const b = (payouts[s] ??= { count: 0, paise: 0 });
      b.count += 1;
      b.paise += Number(e.amountPaise);
      if (NOT_PAID.has(s)) {
        notPaid.count += 1;
        notPaid.paise += Number(e.amountPaise);
        const c = (notPaidByClient[e.clientId] ??= { count: 0, paise: 0 });
        c.count += 1;
        c.paise += Number(e.amountPaise);
      }
    }
    if (notPaid.count === 0) continue;
    rows.push({
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
      notPaidByClient,
    });
  }
  return { rows, limits };
}
