/**
 * PAYOUT CANCELLATION (owner-approved 2026-11-25, every client incl. Deoleo) — the money core shared by the on-screen
 * "Cancel unpaid" / "Cancel failed" actions and the "Cancel payouts — upload file" flow.
 *
 * Who: a GIFSY_ADMIN working inside a client (assumed-tenant token). Never a client admin, never Gifsy staff, never an
 * un-assumed Gifsy session.
 *
 * What may be cancelled (each row must match exactly what the admin saw — status AND amount):
 *  - UNPAID: status PENDING and never in a bank file (downloadId null);
 *  - FAILED: status FAILED (the bank rejected it; it would be re-banked in the next file).
 * Never PROCESSING (with the bank), PAID, REVERSED, CANCELLED, nor a row a pending reversal holds.
 *
 * Side effects recorded when a FAILED row was put in a bank file, and how each is handled (owner 2026-11-25):
 *  - payee snapshot (payeePan / payeePartnerId), downloadId, failureReason / attemptedAt: KEPT as history; every reader
 *    of those columns filters by status (PAID / PROCESSING), so a CANCELLED row is outside them.
 *  - DEDUCT withholding (tdsDeductedPaise + TdsDeductionEntry ledger): already offset when the bank file was marked
 *    FAILED (uploadUtr FIX-3) → the row must show 0 withheld and a net-zero ledger, else REFUSED (TDS_WITHHELD /
 *    TDS_LEDGER_OPEN) — never silently left.
 *  - TDS credit applied at the bank file: released when marked FAILED → any still-live application is REFUSED
 *    (TDS_CREDIT_APPLIED).
 *  - 194C GROSS-UP TDS invoice + TdsRecoveryEntry (and the 194C no-PAN recovery): written at the bank file and NOT
 *    unwound by a FAILED result (they telescope on re-bank). They cannot be safely unwound here (the TDS invoice is a
 *    deposited-tax artefact shared by the PAN's year) → a FAILED 194C row whose PAN / outlet has recovery recorded in
 *    its financial year since the row was created is REFUSED (GROSS_UP_TDS_RECORDED), naming the reason.
 *  - SERVICE invoice (+ GST holdback): VOIDED in the same transaction when every payout it covers ends up cancelled /
 *    reversed; refused when it also covers payouts that stay payable (INVOICE_SHARED), is locked / paid
 *    (INVOICE_LOCKED) or its GST was already released (GST_RELEASED).
 *
 * Whole request or nothing: every row is re-checked under its row lock (credit_batches → credit_payout_entries →
 * auto_invoices, ascending id — the reversal engine's lock order) and ANY row that is no longer cancellable refuses the
 * whole request with the full list. Every apply (and every refusal) writes an audit row.
 */
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatINR } from '../common/money';
import { fyLabelForPeriod } from '../tds/tds.helpers';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

export const CANCELLATION_AUDIT_ENTITY = 'CREDIT_PAYOUT_CANCELLATION';
/** One request (screen or file) may cancel at most this many rows (one transaction, row-locked). */
export const MAX_CANCEL_ROWS = 10_000;
export const CANCEL_REASON_MAX = 500;
const NO_PAN = '__NO_PAN__';

export type CancelKind = 'UNPAID' | 'FAILED';
/** The status a cancellable row has for each kind. */
export const KIND_STATUS: Record<CancelKind, 'PENDING' | 'FAILED'> = { UNPAID: 'PENDING', FAILED: 'FAILED' };
export const KIND_LABEL: Record<CancelKind, string> = {
  UNPAID: 'Cancel unpaid — never sent to the bank',
  FAILED: 'Cancel failed — will not be re-banked',
};

export type CancelBlockCode =
  | 'NOT_FOUND' // no such payout row in this client (wrong client / deleted / mistyped id)
  | 'DUPLICATE' // the same row twice in one request
  | 'PAID'
  | 'IN_BANK_FILE' // PROCESSING — the bank file is with the bank
  | 'REVERSED'
  | 'ALREADY_CANCELLED'
  | 'STATUS_CHANGED' // its status is not the one the admin saw (e.g. re-banked, or FAILED ↔ PENDING)
  | 'AMOUNT_CHANGED'
  | 'WAS_IN_BANK_FILE' // PENDING but has a bank file on record — not "never sent to the bank"
  | 'RESERVED_BY_REVERSAL' // a pending reversal holds the row
  | 'PENDING_REVERSAL' // a pending payout reversal exists for the same upload + outlet + field
  | 'TDS_WITHHELD'
  | 'TDS_LEDGER_OPEN'
  | 'TDS_CREDIT_APPLIED'
  | 'GROSS_UP_TDS_RECORDED'
  | 'INVOICE_LOCKED'
  | 'INVOICE_SHARED'
  | 'GST_RELEASED';

export interface CancelItem {
  id: string;
  /** The status the admin saw (PENDING or FAILED). */
  expectedStatus: 'PENDING' | 'FAILED';
  expectedAmountPaise: bigint;
  /** Per-row reason (the file's Reason column); else the request's reason. */
  reason?: string | null;
}

export interface CancelRowView {
  entryId: string;
  batchId: string;
  batchCode: string;
  outletId: string;
  outletName: string;
  fieldId: string;
  fieldName: string;
  period: string;
  amountPaise: number;
  status: string;
  kind: CancelKind | null;
  downloadCode: string | null;
  failureReason: string | null;
  attemptedAt: string | null;
  autoInvoiceId: string | null;
}

export interface CancelBlock {
  entryId: string;
  code: CancelBlockCode;
  reason: string;
  row: CancelRowView | null;
}

export interface InvoiceVoidPlan {
  id: string;
  invoiceNumber: string;
  outletCode: string;
  period: string;
  totalPaise: number;
  gstHeldPaise: number;
}

export interface CancelEvaluation {
  ok: CancelRowView[];
  blocked: CancelBlock[];
  invoicesToVoid: InvoiceVoidPlan[];
  totals: { unpaid: { count: number; paise: number }; failed: { count: number; paise: number }; all: { count: number; paise: number } };
}

/** Plain-words reason for each refusal (shown on screen, in the preview and in the audit row). */
export function cancelBlockText(code: CancelBlockCode, extra?: string): string {
  const t: Record<CancelBlockCode, string> = {
    NOT_FOUND: 'Not found in this client (wrong client, or the Entry ID is not a payout row)',
    DUPLICATE: 'Listed more than once',
    PAID: 'Already paid — a paid payout cannot be cancelled (use a reversal)',
    IN_BANK_FILE: 'In a bank file that is with the bank now — wait for the bank result',
    REVERSED: 'Already reversed',
    ALREADY_CANCELLED: 'Already cancelled',
    STATUS_CHANGED: 'Its status changed since you looked',
    AMOUNT_CHANGED: 'Its amount differs from the one you saw',
    WAS_IN_BANK_FILE: 'Pending but already on a bank file record — contact Gifsy tech',
    RESERVED_BY_REVERSAL: 'Held by a pending reversal request — approve or reject that first',
    PENDING_REVERSAL: 'A reversal request for this outlet and field in this upload is waiting — approve or reject it first',
    TDS_WITHHELD: 'TDS is still recorded as withheld on it — contact Gifsy tech',
    TDS_LEDGER_OPEN: 'Its TDS ledger is not settled to zero — contact Gifsy tech',
    TDS_CREDIT_APPLIED: 'A TDS credit is still applied to it — contact Gifsy tech',
    GROSS_UP_TDS_RECORDED:
      '194C TDS (gross-up / no-PAN) was already recorded for this payee this financial year when the bank file was made — cancelling would leave TDS charged on a payout that is never paid; contact Gifsy tech',
    INVOICE_LOCKED: 'Its self-billed invoice is locked or paid — it cannot be voided',
    INVOICE_SHARED: 'Its self-billed invoice also covers payouts that stay payable — cancel those too, or contact Gifsy tech',
    GST_RELEASED: 'The GST held on its invoice was already released — it cannot be voided',
  };
  return extra ? `${t[code]} (${extra})` : t[code];
}

/** Owner rule: a Gifsy admin working inside the client. Anyone else is refused (403) with the reason. */
export function assertGifsyAssumed(user: JwtPayload): void {
  if (user?.role !== 'GIFSY_ADMIN') {
    throw new ForbiddenException('Only a Gifsy admin can cancel payouts.');
  }
  if (!user.assumed) {
    throw new ForbiddenException('Open the client first (work in the client) — payouts are cancelled inside one client.');
  }
}

export function normaliseReason(reason: unknown): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r) throw new BadRequestException('A reason is required to cancel payouts.');
  if (r.length > CANCEL_REASON_MAX) throw new BadRequestException(`The reason is too long (max ${CANCEL_REASON_MAX} characters).`);
  return r;
}

type Db = Prisma.TransactionClient;

const ENTRY_SELECT = {
  id: true,
  clientId: true,
  batchId: true,
  outletId: true,
  outletName: true,
  fieldId: true,
  fieldName: true,
  period: true,
  amountPaise: true,
  status: true,
  downloadId: true,
  failureReason: true,
  attemptedAt: true,
  autoInvoiceId: true,
  tdsSection: true,
  tdsDeductedPaise: true,
  payeePan: true,
  createdAt: true,
  batch: { select: { batchCode: true } },
  download: { select: { downloadCode: true } },
} satisfies Prisma.CreditPayoutEntrySelect;

type EntryRow = Prisma.CreditPayoutEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

export function kindOfStatus(status: string): CancelKind | null {
  return status === 'PENDING' ? 'UNPAID' : status === 'FAILED' ? 'FAILED' : null;
}

function view(e: EntryRow): CancelRowView {
  return {
    entryId: e.id,
    batchId: e.batchId,
    batchCode: e.batch?.batchCode ?? '',
    outletId: e.outletId,
    outletName: e.outletName,
    fieldId: e.fieldId,
    fieldName: e.fieldName,
    period: e.period,
    amountPaise: Number(e.amountPaise),
    status: String(e.status),
    kind: kindOfStatus(String(e.status)),
    downloadCode: e.download?.downloadCode ?? null,
    failureReason: e.failureReason ?? null,
    attemptedAt: e.attemptedAt ? e.attemptedAt.toISOString() : null,
    autoInvoiceId: e.autoInvoiceId ?? null,
  };
}

/** The recovery keys a 194C payout belongs to (its payee PAN snapshot, and its no-PAN outlet key). */
function recoveryKeysOf(e: Pick<EntryRow, 'payeePan' | 'outletId'>): { pan: string | null; noPan: string } {
  const p = (e.payeePan ?? '').trim();
  return { pan: p && !p.startsWith(NO_PAN) ? p.toUpperCase() : null, noPan: `${NO_PAN}:${e.outletId}` };
}

/**
 * Evaluate a set of rows for cancellation (reads only — the caller holds the row locks when applying). Every row is
 * classified; nothing is skipped. `items` carry what the admin saw (status + amount).
 */
export async function evaluateCancellation(db: Db, clientId: string, items: CancelItem[]): Promise<CancelEvaluation> {
  const blocked: CancelBlock[] = [];
  const seen = new Set<string>();
  const unique: CancelItem[] = [];
  for (const it of items) {
    if (seen.has(it.id)) {
      blocked.push({ entryId: it.id, code: 'DUPLICATE', reason: cancelBlockText('DUPLICATE'), row: null });
      continue;
    }
    seen.add(it.id);
    unique.push(it);
  }
  const ids = unique.map((i) => i.id);
  const entries: EntryRow[] = ids.length
    ? await db.creditPayoutEntry.findMany({ where: { clientId, id: { in: ids } }, select: ENTRY_SELECT, orderBy: { id: 'asc' } })
    : [];
  const byId = new Map(entries.map((e) => [e.id, e]));

  // Side information, batched (no per-row queries).
  const [reserved, pendingReversals, ledger, creditApps] = ids.length
    ? await Promise.all([
        db.payoutReversalAllocation.findMany({ where: { payoutEntryId: { in: ids }, state: 'RESERVED' }, select: { payoutEntryId: true } }),
        db.creditReversal.findMany({
          where: { clientId, awardType: 'PAYOUT', status: 'PENDING_GIFSY', batchId: { in: [...new Set(entries.map((e) => e.batchId))] } },
          select: { batchId: true, outletId: true, fieldId: true },
        }),
        db.tdsDeductionEntry.findMany({ where: { creditPayoutEntryId: { in: ids } }, select: { creditPayoutEntryId: true, tdsDeductedThisPaise: true } }),
        db.tdsCreditApplication.findMany({ where: { payoutEntryId: { in: ids }, releasedAt: null }, select: { payoutEntryId: true } }),
      ])
    : [[], [], [], []];
  const reservedSet = new Set(reserved.map((r) => r.payoutEntryId));
  const pendingKey = new Set(pendingReversals.map((r) => `${r.batchId}|${r.outletId}|${r.fieldId}`));
  const ledgerNet = new Map<string, bigint>();
  for (const l of ledger) {
    if (!l.creditPayoutEntryId) continue;
    ledgerNet.set(l.creditPayoutEntryId, (ledgerNet.get(l.creditPayoutEntryId) ?? 0n) + l.tdsDeductedThisPaise);
  }
  const creditSet = new Set(creditApps.map((c) => c.payoutEntryId));

  // 194C gross-up / no-PAN recovery recorded since a FAILED row was created (see header).
  const failed194c = entries.filter((e) => String(e.status) === 'FAILED' && e.tdsSection === 'SEC_194C');
  const recoveryHit = new Set<string>();
  if (failed194c.length > 0) {
    const ors: Prisma.TdsRecoveryEntryWhereInput[] = [];
    for (const e of failed194c) {
      const k = recoveryKeysOf(e);
      const fy = fyLabelForPeriod(e.period);
      if (k.pan) ors.push({ panNumber: k.pan, fyLabel: fy, createdAt: { gte: e.createdAt } });
      ors.push({ clientId, panNumber: k.noPan, fyLabel: fy, createdAt: { gte: e.createdAt } });
    }
    const rec = await db.tdsRecoveryEntry.findMany({
      where: { section: 'SEC_194C', OR: ors },
      select: { panNumber: true, fyLabel: true, createdAt: true, clientId: true },
    });
    for (const e of failed194c) {
      const k = recoveryKeysOf(e);
      const fy = fyLabelForPeriod(e.period);
      const hit = rec.some(
        (r) =>
          r.fyLabel === fy &&
          r.createdAt.getTime() >= e.createdAt.getTime() &&
          ((k.pan && r.panNumber.trim().toUpperCase() === k.pan) || (r.panNumber === k.noPan && r.clientId === clientId)),
      );
      if (hit) recoveryHit.add(e.id);
    }
  }

  const okEntries: EntryRow[] = [];
  for (const it of unique) {
    const e = byId.get(it.id);
    const block = (code: CancelBlockCode, extra?: string) =>
      blocked.push({ entryId: it.id, code, reason: cancelBlockText(code, extra), row: e ? view(e) : null });
    if (!e) { block('NOT_FOUND'); continue; }
    const st = String(e.status);
    if (st === 'PAID') { block('PAID'); continue; }
    if (st === 'PROCESSING') { block('IN_BANK_FILE', e.download?.downloadCode ? `bank file ${e.download.downloadCode}` : undefined); continue; }
    if (st === 'REVERSED') { block('REVERSED'); continue; }
    if (st === 'CANCELLED') { block('ALREADY_CANCELLED'); continue; }
    if (st !== it.expectedStatus) { block('STATUS_CHANGED', `now ${st === 'PENDING' ? 'pending' : st.toLowerCase()}, you saw ${it.expectedStatus.toLowerCase()}`); continue; }
    if (e.amountPaise !== it.expectedAmountPaise) {
      block('AMOUNT_CHANGED', `now ${formatINR(e.amountPaise)}, you saw ${formatINR(it.expectedAmountPaise)}`);
      continue;
    }
    if (st === 'PENDING' && e.downloadId != null) { block('WAS_IN_BANK_FILE'); continue; }
    if (reservedSet.has(e.id)) { block('RESERVED_BY_REVERSAL'); continue; }
    if (pendingKey.has(`${e.batchId}|${e.outletId}|${e.fieldId}`)) { block('PENDING_REVERSAL'); continue; }
    if ((e.tdsDeductedPaise ?? 0n) !== 0n) { block('TDS_WITHHELD', formatINR(e.tdsDeductedPaise)); continue; }
    if ((ledgerNet.get(e.id) ?? 0n) !== 0n) { block('TDS_LEDGER_OPEN', formatINR(ledgerNet.get(e.id)!)); continue; }
    if (creditSet.has(e.id)) { block('TDS_CREDIT_APPLIED'); continue; }
    if (recoveryHit.has(e.id)) { block('GROSS_UP_TDS_RECORDED'); continue; }
    okEntries.push(e);
  }

  // SERVICE invoices: void only when every payout on it ends cancelled / reversed.
  const invoicesToVoid: InvoiceVoidPlan[] = [];
  const invIds = [...new Set(okEntries.map((e) => e.autoInvoiceId).filter((x): x is string => !!x))].sort();
  if (invIds.length > 0) {
    const okIds = new Set(okEntries.map((e) => e.id));
    const [invoices, linked, gst] = await Promise.all([
      db.autoInvoice.findMany({
        where: { id: { in: invIds }, clientId },
        select: { id: true, invoiceNumber: true, outletCode: true, period: true, status: true, lockedAt: true, totalPaise: true },
      }),
      db.creditPayoutEntry.findMany({ where: { autoInvoiceId: { in: invIds } }, select: { id: true, autoInvoiceId: true, status: true } }),
      db.gstReimbursement.findMany({ where: { autoInvoiceId: { in: invIds } }, select: { autoInvoiceId: true, status: true, gstPaise: true } }),
    ]);
    const badInvoice = new Map<string, { code: CancelBlockCode; extra: string }>();
    for (const inv of invoices) {
      const g = gst.find((x) => x.autoInvoiceId === inv.id);
      if (String(inv.status) === 'VOID') continue; // already void (nothing left to do)
      if (String(inv.status) !== 'GENERATED' || inv.lockedAt != null) {
        badInvoice.set(inv.id, { code: 'INVOICE_LOCKED', extra: `invoice ${inv.invoiceNumber}` });
        continue;
      }
      if (g && String(g.status) === 'RELEASED') {
        badInvoice.set(inv.id, { code: 'GST_RELEASED', extra: `invoice ${inv.invoiceNumber}` });
        continue;
      }
      const stays = linked.filter(
        (l) => l.autoInvoiceId === inv.id && !okIds.has(l.id) && String(l.status) !== 'CANCELLED' && String(l.status) !== 'REVERSED',
      );
      if (stays.length > 0) {
        badInvoice.set(inv.id, { code: 'INVOICE_SHARED', extra: `invoice ${inv.invoiceNumber} — ${stays.length} other payout${stays.length === 1 ? '' : 's'}` });
        continue;
      }
      invoicesToVoid.push({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        outletCode: inv.outletCode,
        period: inv.period,
        totalPaise: Number(inv.totalPaise),
        gstHeldPaise: g && String(g.status) === 'HELD' ? Number(g.gstPaise) : 0,
      });
    }
    if (badInvoice.size > 0) {
      for (let i = okEntries.length - 1; i >= 0; i--) {
        const e = okEntries[i];
        const bad = e.autoInvoiceId ? badInvoice.get(e.autoInvoiceId) : undefined;
        if (!bad) continue;
        blocked.push({ entryId: e.id, code: bad.code, reason: cancelBlockText(bad.code, bad.extra), row: view(e) });
        okEntries.splice(i, 1);
      }
      // An invoice is voided only when ALL its rows are cancelled in this request → drop any plan touched by a refusal.
      const stillOk = new Set(okEntries.map((e) => e.autoInvoiceId));
      for (let i = invoicesToVoid.length - 1; i >= 0; i--) if (!stillOk.has(invoicesToVoid[i].id)) invoicesToVoid.splice(i, 1);
    }
  }

  const ok = okEntries.map(view);
  const sum = (rows: CancelRowView[]) => ({ count: rows.length, paise: rows.reduce((s, r) => s + r.amountPaise, 0) });
  return {
    ok,
    blocked,
    invoicesToVoid,
    totals: { unpaid: sum(ok.filter((r) => r.kind === 'UNPAID')), failed: sum(ok.filter((r) => r.kind === 'FAILED')), all: sum(ok) },
  };
}

/** The refusal thrown when any row is not cancellable — the whole request is refused, every row listed. */
export function refusal(blocked: CancelBlock[], total: number): ConflictException {
  const head = blocked.slice(0, 5).map((b) => `${b.row ? `${b.row.outletId} ${formatINR(b.row.amountPaise)}` : b.entryId}: ${b.reason}`);
  return new ConflictException({
    message:
      `Nothing was cancelled — ${blocked.length} of ${total} row${total === 1 ? '' : 's'} can't be cancelled: ` +
      head.join('; ') +
      (blocked.length > 5 ? `; …and ${blocked.length - 5} more (listed below)` : '') +
      '. Remove them (or reload) and try again.',
    details: { blocked },
  });
}

export interface ApplyCancellationInput {
  clientId: string;
  actorId: string;
  reason: string;
  items: CancelItem[];
  source: 'SCREEN' | 'FILE';
  /** Screen only — the action used (every row must be of this kind). */
  kind?: CancelKind;
  file?: { key: string | null; name: string; acknowledgedBlocked: CancelBlock[] } | null;
}

export interface ApplyCancellationResult {
  cancellationId: string;
  cancelled: CancelRowView[];
  invoicesVoided: InvoiceVoidPlan[];
  totals: CancelEvaluation['totals'];
}

/**
 * Apply a cancellation INSIDE the caller's transaction. Locks credit_batches (ascending id) → the rows (ascending id)
 * → their SERVICE invoices (ascending id), re-evaluates under the locks and refuses the WHOLE request on any problem.
 */
export async function applyCancellation(tx: Db, input: ApplyCancellationInput): Promise<ApplyCancellationResult> {
  const { clientId, items } = input;
  if (items.length === 0) throw new BadRequestException('Select at least one payout row to cancel.');
  if (items.length > MAX_CANCEL_ROWS) {
    throw new BadRequestException(`At most ${MAX_CANCEL_ROWS.toLocaleString('en-IN')} rows can be cancelled in one go — split the file.`);
  }
  if (input.kind) {
    const want = KIND_STATUS[input.kind];
    const wrong = items.filter((i) => i.expectedStatus !== want);
    if (wrong.length > 0) {
      throw new BadRequestException(
        `${KIND_LABEL[input.kind]}: ${wrong.length} selected row${wrong.length === 1 ? ' is' : 's are'} not ${want === 'PENDING' ? 'unpaid' : 'failed'} — use the other action for them.`,
      );
    }
  }
  const ids = [...new Set(items.map((i) => i.id))].sort();
  // Lock order (reversal engine §5): credit_batches → credit_payout_entries → auto_invoices, each ascending id.
  const batchRows = await tx.creditPayoutEntry.findMany({ where: { clientId, id: { in: ids } }, select: { batchId: true } });
  const batchIds = [...new Set(batchRows.map((b) => b.batchId))].sort();
  if (batchIds.length > 0) {
    await tx.$queryRaw`SELECT id FROM credit_batches WHERE "clientId" = ${clientId} AND id IN (${Prisma.join(batchIds)}) ORDER BY id FOR UPDATE`;
  }
  await tx.$queryRaw`SELECT id FROM credit_payout_entries WHERE "clientId" = ${clientId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
  const invRows = await tx.creditPayoutEntry.findMany({
    where: { clientId, id: { in: ids }, autoInvoiceId: { not: null } },
    select: { autoInvoiceId: true },
  });
  const invIds = [...new Set(invRows.map((r) => r.autoInvoiceId!))].sort();
  if (invIds.length > 0) {
    await tx.$queryRaw`SELECT id FROM auto_invoices WHERE "clientId" = ${clientId} AND id IN (${Prisma.join(invIds)}) ORDER BY id FOR UPDATE`;
  }

  const ev = await evaluateCancellation(tx, clientId, items);
  if (ev.blocked.length > 0) throw refusal(ev.blocked, items.length);

  const now = new Date();
  const reasonOf = new Map(items.map((i) => [i.id, (i.reason ?? '').trim() || input.reason]));
  // One guarded write per (kind, reason) group. Guarded on what was read under the row lock: PENDING never in a bank
  // file / FAILED. A count mismatch = the row moved under us (impossible while locked, defensive) → roll back all.
  const groups = new Map<string, { kind: CancelKind; reason: string; ids: string[] }>();
  for (const r of ev.ok) {
    const reason = reasonOf.get(r.entryId) ?? input.reason;
    const key = `${r.kind}|${reason}`;
    const g = groups.get(key) ?? { kind: r.kind as CancelKind, reason, ids: [] };
    g.ids.push(r.entryId);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const data = { status: 'CANCELLED' as const, cancelledAt: now, cancelledById: input.actorId, cancelReason: g.reason };
    const r =
      g.kind === 'UNPAID'
        ? await tx.creditPayoutEntry.updateMany({ where: { clientId, id: { in: g.ids }, status: 'PENDING', downloadId: null }, data })
        : await tx.creditPayoutEntry.updateMany({ where: { clientId, id: { in: g.ids }, status: 'FAILED' }, data });
    if (r.count !== g.ids.length) {
      throw new ConflictException('A payout changed while it was being cancelled — nothing was cancelled; reload and retry.');
    }
  }

  const voidReason = `All payouts on this invoice were cancelled before payment: ${input.reason}`.slice(0, CANCEL_REASON_MAX + 80);
  for (const inv of ev.invoicesToVoid) {
    const v = await tx.autoInvoice.updateMany({
      where: { id: inv.id, clientId, status: 'GENERATED', lockedAt: null },
      data: { status: 'VOID', voidedAt: now, voidedById: input.actorId, voidReason },
    });
    if (v.count !== 1) throw new ConflictException(`Invoice ${inv.invoiceNumber} changed while it was being voided — nothing was cancelled; retry.`);
    await tx.gstReimbursement.updateMany({
      where: { autoInvoiceId: inv.id, status: 'HELD' },
      data: { status: 'VOID', notes: `Invoice voided ${now.toISOString().slice(0, 10)} — the payouts were cancelled before payment.` },
    });
  }

  // Audit: one row per upload (batch) so the upload's history shows it; all share the cancellation id.
  const cancellationId = randomUUID();
  const byBatch = new Map<string, CancelRowView[]>();
  for (const r of ev.ok) byBatch.set(r.batchId, [...(byBatch.get(r.batchId) ?? []), r]);
  for (const [batchId, rows] of byBatch) {
    await tx.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: CANCELLATION_AUDIT_ENTITY,
        entityId: batchId,
        actorId: input.actorId,
        metadata: toJson({
          event: 'PAYOUTS_CANCELLED',
          cancellationId,
          clientId,
          source: input.source,
          kind: input.kind ?? null,
          reason: input.reason,
          at: now.toISOString(),
          batchCode: rows[0]?.batchCode ?? null,
          count: rows.length,
          amountPaise: rows.reduce((s, r) => s + r.amountPaise, 0),
          requestTotals: ev.totals,
          rows: rows.map((r) => ({ ...r, reason: reasonOf.get(r.entryId) ?? input.reason })),
          invoicesVoided: ev.invoicesToVoid.filter((i) => rows.some((r) => r.autoInvoiceId === i.id)),
          file: input.file ? { key: input.file.key, name: input.file.name } : null,
          acknowledgedNotCancelled: input.file?.acknowledgedBlocked ?? [],
        }),
      },
    });
  }
  return { cancellationId, cancelled: ev.ok, invoicesVoided: ev.invoicesToVoid, totals: ev.totals };
}

/** JSON-safe (BigInt → string) metadata for an audit row. */
export function toJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as Prisma.InputJsonValue;
}
