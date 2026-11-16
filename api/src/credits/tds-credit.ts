/**
 * TDS credits from reversed PAID payouts — Wallet Reversal Engine policy round B (owner 2026-11-16,
 * WALLET-REVERSAL-ENGINE-DESIGN.md §8.1).
 *
 * Reversing an already-PAID payout entry (reversal engine V2) whose TDS was DEDUCTED:
 *  - the receivable recorded is the NET cash the retailer actually received (amount − TDS withheld);
 *  - the withheld TDS stays deposited with the government. It becomes a TdsCredit on the PAN, scoped to the TENANT
 *    that reversed it + the TDS section + the financial year, and the reversed entry's base leaves the PAN's
 *    cumulative TDS base (the income was reversed);
 *  - the next DEDUCT withholding that tenant computes for the PAN (bank download, under the same PAN advisory lock)
 *    is reduced by the credit — e.g. ₹500 due, ₹200 credit → ₹300 withheld — and any remainder carries forward;
 *  - an application is RELEASED (credit restored) when the payout it reduced never happens (UTR FAILED, or the entry
 *    is cancelled by a reversal); a later re-bank re-applies whatever is outstanding.
 *
 * Why the math is consistent with the cumulative DEDUCT ledger (buildPayoutTdsPlan): removing the reversed base
 * makes Σ deposited (ledger) exceed the TDS due by exactly the credit, so the ledger alone would already withhold
 * less next time — but for WHICHEVER tenant paid that PAN next. The plan therefore (a) hides other tenants'
 * outstanding credits from a tenant's prior-deducted figure (tenant scope) and (b) computes the deduction with and
 * without the tenant's own credits: the difference IS the credit applied (never more than outstanding, never more
 * than the TDS due). With no credits at all (every LEGACY tenant, Deoleo) both figures equal today's.
 *
 * Concurrency: credit creation (reversal approve) and application (download) both hold the PAN advisory lock
 * `PAN|<pan>|<fy>`; every write is a guarded UPDATE (appliedPaise + x ≤ amountPaise; release flips releasedAt NULL →
 * now exactly once) backed by SQL CHECKs and the partial unique index on live applications.
 */
import { Prisma, TdsSection } from '@prisma/client';
import { allocateProRataRecovery, computeDeduction } from '../tds/tds-methodology.helper';
import type { TdsRate } from '../tds/tds.helpers';
import { formatINR } from '../common/money';

/** IST FY label ("2026-27") for a "YYYY-MM" payout period — same rule as CreditsService.fyForPeriod. */
export function fyLabelOf(period: string): string {
  const [y, m] = period.split('-').map((s) => parseInt(s, 10));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The PAN advisory-lock key shared with the bank download (FIX-8). */
export function panLockKey(pan: string, fyLabel: string): string {
  return `PAN|${pan}|${fyLabel}`;
}

/** Mask a PAN for screens / notes: XXXXX1234F. */
export function maskPan(pan: string): string {
  const p = pan.trim().toUpperCase();
  return p.length >= 5 ? `XXXXX${p.slice(5)}` : p;
}

export interface OpenTdsCredit {
  id: string;
  clientId: string;
  panNumber: string;
  section: TdsSection;
  fyLabel: string;
  amountPaise: bigint;
  appliedPaise: bigint;
  createdAt: Date;
}

/** Credits with something left on the given PANs / sections in one FY, oldest first (FIFO use). */
export async function loadOpenTdsCredits(
  db: Prisma.TransactionClient,
  q: { pans: string[]; sections: TdsSection[]; fyLabel: string },
): Promise<OpenTdsCredit[]> {
  if (q.pans.length === 0 || q.sections.length === 0) return [];
  const rows = await db.tdsCredit.findMany({
    where: { panNumber: { in: q.pans }, section: { in: q.sections }, fyLabel: q.fyLabel },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, clientId: true, panNumber: true, section: true, fyLabel: true,
      amountPaise: true, appliedPaise: true, createdAt: true,
    },
  });
  return (rows ?? []).filter((r) => r.amountPaise > r.appliedPaise);
}

const outstanding = (c: Pick<OpenTdsCredit, 'amountPaise' | 'appliedPaise'>) => c.amountPaise - c.appliedPaise;

export interface CreditDraw {
  tdsCreditId: string;
  payoutEntryId: string;
  amountPaise: bigint;
}

export interface DeductWithCreditsResult {
  /** The figures the ledger records (credit-aware). */
  tdsDueCumulativePaise: bigint;
  carryForwardPaise: bigint;
  /** What this event would have withheld had no own credit existed ("the TDS due on this payout"). */
  dueThisPaise: bigint;
  /** New cash actually withheld this event = dueThisPaise − creditAppliedPaise. */
  withheldThisPaise: bigint;
  creditAppliedPaise: bigint;
  /** Per entry: new withholding (stamped on the entry + ledger) and the credit used for it. */
  perEntry: Array<{ entryId: string; withheldPaise: bigint; creditPaise: bigint }>;
  draws: CreditDraw[];
}

/**
 * PURE — one DEDUCT (PAN, section, methodology) group of a download, credit-aware.
 * `priorDeductedPaise` = Σ ledger (all tenants); `credits` = the open credits of this PAN + section + FY (any tenant).
 * Other tenants' outstanding credits are removed from the prior figure (they are not this tenant's to use);
 * the tenant's own credits are applied FIFO. With no credits the result equals computeDeduction + the existing
 * exact pro-rata split (bit-for-bit — the caller's legacy branch).
 */
export function deductWithCredits(input: {
  clientId: string;
  cumulativeBasePaise: bigint;
  priorDeductedPaise: bigint;
  thisPayoutPaise: bigint;
  rate: TdsRate;
  thresholdMetOnCumulative: boolean;
  entries: Array<{ id: string; amountPaise: bigint }>;
  credits: OpenTdsCredit[];
}): DeductWithCreditsResult {
  const own = input.credits.filter((c) => c.clientId === input.clientId && outstanding(c) > 0n);
  const othersOutstanding = input.credits
    .filter((c) => c.clientId !== input.clientId)
    .reduce((s, c) => s + (outstanding(c) > 0n ? outstanding(c) : 0n), 0n);
  const ownOutstanding = own.reduce((s, c) => s + outstanding(c), 0n);
  const base = {
    cumulativeBasePaise: input.cumulativeBasePaise,
    thisPayoutPaise: input.thisPayoutPaise,
    rate: input.rate,
    thresholdMetOnCumulative: input.thresholdMetOnCumulative,
  };
  const priorEff = input.priorDeductedPaise - othersOutstanding;
  const withC = computeDeduction({ ...base, priorDeductedPaise: priorEff });
  const withoutC =
    ownOutstanding > 0n ? computeDeduction({ ...base, priorDeductedPaise: priorEff - ownOutstanding }) : withC;
  // computeDeduction is non-increasing in prior with slope ≥ −1 → 0 ≤ applied ≤ ownOutstanding.
  let applied = withoutC.tdsDeductThisPaise - withC.tdsDeductThisPaise;
  if (applied < 0n) applied = 0n;
  if (applied > ownOutstanding) applied = ownOutstanding;

  const due = withoutC.tdsDeductThisPaise;
  const dueSplit = due > 0n
    ? allocateProRataRecovery({
        panTdsTotalPaise: due,
        tenants: input.entries.map((e) => ({ clientId: e.id, basePaise: e.amountPaise })),
      })
    : input.entries.map((e) => ({ clientId: e.id, tenantSharePaise: 0n }));
  const dueBy = new Map(dueSplit.map((s): [string, bigint] => [s.clientId, s.tenantSharePaise]));
  // The credit follows the TDS due (never more than an entry's own due → withheld ≥ 0, Σ exact).
  const creditSplit = applied > 0n
    ? allocateProRataRecovery({
        panTdsTotalPaise: applied,
        tenants: input.entries.map((e) => ({ clientId: e.id, basePaise: dueBy.get(e.id) ?? 0n })),
      })
    : [];
  const creditBy = new Map(creditSplit.map((s): [string, bigint] => [s.clientId, s.tenantSharePaise]));

  const perEntry = input.entries.map((e) => {
    const d = dueBy.get(e.id) ?? 0n;
    const c = creditBy.get(e.id) ?? 0n;
    return { entryId: e.id, withheldPaise: d - c, creditPaise: c };
  });

  // FIFO draw of the tenant's own credits, entry by entry.
  const draws: CreditDraw[] = [];
  const left = own.map((c) => ({ id: c.id, left: outstanding(c) }));
  let k = 0;
  for (const pe of perEntry) {
    let need = pe.creditPaise;
    while (need > 0n && k < left.length) {
      const take = left[k].left < need ? left[k].left : need;
      if (take > 0n) {
        draws.push({ tdsCreditId: left[k].id, payoutEntryId: pe.entryId, amountPaise: take });
        left[k].left -= take;
        need -= take;
      }
      if (left[k].left === 0n) k++;
    }
  }

  return {
    tdsDueCumulativePaise: withC.tdsDueCumulativePaise,
    carryForwardPaise: withC.carryForwardPaise,
    dueThisPaise: due,
    withheldThisPaise: due - applied,
    creditAppliedPaise: applied,
    perEntry,
    draws,
  };
}

/**
 * Download tx: record the draws (one application row each) and bump the credits' appliedPaise with a guarded
 * UPDATE — a credit can never be used beyond its amount even if the caller's plan were stale.
 */
export async function writeCreditApplications(
  tx: Prisma.TransactionClient,
  draws: CreditDraw[],
  ctx: { clientId: string; downloadId: string },
): Promise<void> {
  for (const d of draws) {
    const n = await tx.$executeRaw`UPDATE tds_credits SET "appliedPaise" = "appliedPaise" + ${d.amountPaise}, "updatedAt" = now()
      WHERE id = ${d.tdsCreditId} AND "clientId" = ${ctx.clientId} AND "appliedPaise" + ${d.amountPaise} <= "amountPaise"`;
    if (n !== 1) {
      throw new Error(`TDS credit ${d.tdsCreditId} changed while the payout file was being built — retry the download`);
    }
  }
  if (draws.length > 0) {
    await tx.tdsCreditApplication.createMany({
      data: draws.map((d) => ({
        tdsCreditId: d.tdsCreditId,
        clientId: ctx.clientId,
        payoutEntryId: d.payoutEntryId,
        downloadId: ctx.downloadId,
        amountPaise: d.amountPaise,
      })),
    });
  }
}

export interface ReleasedApplication {
  applicationId: string;
  tdsCreditId: string;
  payoutEntryId: string;
  amountPaise: bigint;
}

/**
 * The payouts these entries were part of will not be paid (UTR FAILED / cancelled by a reversal): give the TDS
 * credit they used back. Idempotent — each live application is flipped exactly once (releasedAt NULL guard).
 * Returns what was released (empty for every tenant without credits → no writes).
 */
export async function releaseCreditApplications(
  tx: Prisma.TransactionClient,
  entryIds: string[],
  reason: 'PAYOUT_FAILED' | 'ENTRY_CANCELLED_BY_REVERSAL',
): Promise<ReleasedApplication[]> {
  if (entryIds.length === 0) return [];
  const live = await tx.tdsCreditApplication.findMany({
    where: { payoutEntryId: { in: entryIds }, releasedAt: null },
    orderBy: { id: 'asc' },
    select: { id: true, tdsCreditId: true, payoutEntryId: true, amountPaise: true },
  });
  const out: ReleasedApplication[] = [];
  for (const a of live ?? []) {
    const flip = await tx.tdsCreditApplication.updateMany({
      where: { id: a.id, releasedAt: null },
      data: { releasedAt: new Date(), releaseReason: reason },
    });
    if (flip.count !== 1) continue; // released concurrently — nothing to give back twice
    const n = await tx.$executeRaw`UPDATE tds_credits SET "appliedPaise" = "appliedPaise" - ${a.amountPaise}, "updatedAt" = now()
      WHERE id = ${a.tdsCreditId} AND "appliedPaise" >= ${a.amountPaise}`;
    if (n !== 1) throw new Error(`TDS credit ${a.tdsCreditId} is inconsistent (release of ${a.amountPaise} paise) — contact Gifsy`);
    out.push({ applicationId: a.id, tdsCreditId: a.tdsCreditId, payoutEntryId: a.payoutEntryId, amountPaise: a.amountPaise });
  }
  return out;
}

export interface ReceivableTdsOutcome {
  /** Net cash the retailer actually received = the receivable recorded. */
  receivablePaise: bigint;
  /** TDS that stays deposited and became a credit on the PAN (0 → none created). */
  tdsCreditPaise: bigint;
  tdsCreditId: string | null;
  panMasked: string | null;
  /** Of the credit: the entry's own withholding / earlier credit that had been applied to this payout. */
  ownWithheldPaise: bigint;
  earlierCreditPaise: bigint;
  /** Withheld on the entry but not traceable to a PAN in the TDS ledger (e.g. imported history) — no credit. */
  untrackedWithheldPaise: bigint;
  note: string;
}

/**
 * The PAN lock key an entry's receivable will need (read-only; null when it carries no TDS). Called for every
 * PAID entry BEFORE any is processed so the approve takes all its PAN locks in sorted order (deadlock-free).
 */
export async function receivablePanLockKey(
  tx: Prisma.TransactionClient,
  e: { id: string; period: string; tdsDeductedPaise: bigint },
): Promise<string | null> {
  const pan = await panOfEntry(tx, e.id);
  return pan ? panLockKey(pan, fyLabelOf(e.period)) : null;
}

async function panOfEntry(tx: Prisma.TransactionClient, entryId: string): Promise<string | null> {
  const ledger = await tx.tdsDeductionEntry.findMany({
    where: { creditPayoutEntryId: entryId },
    orderBy: { createdAt: 'desc' },
    select: { panNumber: true, tdsDeductedThisPaise: true },
  });
  const fromLedger = (ledger ?? []).find((r) => r.tdsDeductedThisPaise > 0n && r.panNumber)?.panNumber ?? null;
  if (fromLedger) return fromLedger;
  const app = await tx.tdsCreditApplication.findFirst({
    where: { payoutEntryId: entryId, releasedAt: null },
    select: { tdsCredit: { select: { panNumber: true } } },
  });
  return app?.tdsCredit?.panNumber ?? null;
}

/**
 * V2 approve of a PAID entry (the caller holds the batch lock, the entry row lock and — via receivablePanLockKey —
 * the PAN advisory lock). Decides the receivable and creates the TDS credit (owner decision 2):
 *  - receivable = amount − tdsDeductedPaise (net cash received);
 *  - credit = the entry's own withholding as booked in the TDS ledger (net Σ for the entry, capped at the stamp)
 *    + any earlier credit that had been applied to this payout (that TDS was attributed to this, now reversed,
 *    income — it is all deposited, so it all comes back as credit on the same PAN);
 *  - GROSS_UP (nothing withheld) → no credit; withheld but untraceable → no credit, called out.
 * One credit per entry (`sourcePayoutEntryId` unique).
 */
export async function recordReceivableTds(
  tx: Prisma.TransactionClient,
  e: {
    id: string;
    clientId: string;
    amountPaise: bigint;
    period: string;
    tdsSection: TdsSection | null;
    tdsMethodology: string | null;
    tdsDeductedPaise: bigint;
  },
  ctx: { creditReversalId: string; actorId: string },
): Promise<ReceivableTdsOutcome> {
  const withheld = e.tdsDeductedPaise > 0n ? e.tdsDeductedPaise : 0n;
  const receivablePaise = e.amountPaise - withheld;
  const ledger = await tx.tdsDeductionEntry.findMany({
    where: { creditPayoutEntryId: e.id },
    orderBy: { createdAt: 'desc' },
    select: { panNumber: true, tdsDeductedThisPaise: true },
  });
  const ledgerNet = (ledger ?? []).reduce((s, r) => s + r.tdsDeductedThisPaise, 0n);
  const ledgerPan = (ledger ?? []).find((r) => r.tdsDeductedThisPaise > 0n && r.panNumber)?.panNumber ?? null;
  const ownWithheld = ledgerPan && withheld > 0n ? (ledgerNet < withheld ? (ledgerNet > 0n ? ledgerNet : 0n) : withheld) : 0n;
  const untracked = withheld - ownWithheld;

  const apps = await tx.tdsCreditApplication.findMany({
    where: { payoutEntryId: e.id, releasedAt: null },
    select: { amountPaise: true, tdsCredit: { select: { panNumber: true } } },
  });
  const earlier = (apps ?? []).reduce((s, a) => s + a.amountPaise, 0n);
  const pan = ledgerPan ?? (apps ?? []).find((a) => a.tdsCredit?.panNumber)?.tdsCredit?.panNumber ?? null;
  const credit = ownWithheld + earlier;

  const untrackedNote =
    untracked > 0n
      ? ` ${formatINR(untracked)} TDS on this entry is not in Gifsy's TDS ledger (e.g. imported history or no PAN) — no credit for it; correct it off-platform.`
      : '';

  if (credit <= 0n || !pan || !e.tdsSection) {
    const isGrossUp = e.tdsMethodology === 'GROSS_UP';
    return {
      receivablePaise,
      tdsCreditPaise: 0n,
      tdsCreditId: null,
      panMasked: pan ? maskPan(pan) : null,
      ownWithheldPaise: 0n,
      earlierCreditPaise: 0n,
      untrackedWithheldPaise: untracked,
      note:
        (isGrossUp
          ? 'No TDS was withheld from the retailer (gross-up: the program paid the TDS on top) — receivable = amount paid, no TDS credit.'
          : withheld === 0n
            ? 'No TDS was withheld on this entry — receivable = amount paid, no TDS credit.'
            : `Receivable = net received ${formatINR(receivablePaise)}.`) + untrackedNote,
    };
  }

  const fyLabel = fyLabelOf(e.period);
  const created = await tx.tdsCredit.create({
    data: {
      clientId: e.clientId,
      panNumber: pan,
      section: e.tdsSection,
      fyLabel,
      sourcePayoutEntryId: e.id,
      creditReversalId: ctx.creditReversalId,
      amountPaise: credit,
      createdBy: ctx.actorId,
    },
    select: { id: true },
  });
  const parts = [
    ownWithheld > 0n ? `${formatINR(ownWithheld)} withheld from this payout` : null,
    earlier > 0n ? `${formatINR(earlier)} earlier TDS credit that had been used for this payout` : null,
  ].filter(Boolean);
  return {
    receivablePaise,
    tdsCreditPaise: credit,
    tdsCreditId: created.id,
    panMasked: maskPan(pan),
    ownWithheldPaise: ownWithheld,
    earlierCreditPaise: earlier,
    untrackedWithheldPaise: untracked,
    note:
      `${formatINR(credit)} TDS credit carried forward on PAN ${maskPan(pan)} (${parts.join(' + ')}) — it stays deposited ` +
      `with the government and is adjusted against the next TDS this program deducts for that PAN in FY ${fyLabel}.` +
      untrackedNote,
  };
}
