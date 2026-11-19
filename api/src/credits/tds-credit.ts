/**
 * TDS credits from reversed PAID payouts — Wallet Reversal Engine policy round B + fix round B (owner 2026-11-16,
 * WALLET-REVERSAL-ENGINE-DESIGN.md §8.1).
 *
 * Reversing an already-PAID payout entry (reversal engine V2):
 *  - the receivable recorded is the NET cash the retailer actually received (amount − TDS withheld);
 *  - the entry's amount ALWAYS leaves the PAN's yearly TDS base, whether or not TDS was withheld (D1 — marker
 *    `CreditPayoutEntry.tdsBaseReversedAt`): the income was reversed;
 *  - the withheld TDS stays deposited with the government. The part of it the PAN no longer owes becomes a TdsCredit
 *    on the PAN + section + FY — capped at the drop in cumulative TDS due (H1: catch-up TDS that covered the
 *    retailer's OTHER payouts still covers them, so it is not credited);
 *  - the credit is used ONLY by the client that raised it (merge decision 2026-11-19 — replaces D4's cross-programme
 *    194C use: Deoleo's downloads never see another programme's credit), 194R and 194C alike;
 *  - 194R (merge decision A, 2026-11-19): built on the shipped whole-year 194R calculation — the base is
 *    `collect194RBases` (D1 filter inside), the cap uses the same `liability194R` deduct part as the report, the
 *    credit is keyed on the ledger row's own retailer key (payee snapshot) and FY, under the `R194|client|FY` lock;
 *  - the next DEDUCT withholding in scope (bank download, under the same PAN advisory lock) is reduced by the credit —
 *    e.g. ₹500 due, ₹200 credit → ₹300 withheld — and any remainder carries forward within the FY (D2: not into the
 *    next FY; the report says so);
 *  - when the reversal takes the PAN below the threshold, the TDS deposited beyond what is due and beyond the
 *    explicit credits is handed back by the cumulative ledger on the next payout — and said so on that payout's TDS
 *    line (D3: "₹X less TDS: adjusted after a reversal brought PAN below the limit");
 *  - an application is RELEASED (credit restored) when the payout it reduced never happens (UTR FAILED, or the entry
 *    is cancelled by a reversal); a later re-bank re-applies whatever is outstanding.
 *
 * Why the math is consistent with the cumulative DEDUCT ledger (buildPayoutTdsPlan): in a deductor scope,
 * Σ ledger − Σ outstanding credits = TDS due on the base + the hand-back surplus. The credit cap at approve keeps that
 * identity (credit = min(own + earlier, surplus)); the download then withholds `computeDeduction(prior = ledger)`
 * (unchanged money) and only EXPLAINS the difference to the no-credit / no-surplus figure as credit and hand-back.
 * With no credits and no reversed base (every LEGACY tenant, Deoleo today) the figures are bit-for-bit today's.
 *
 * Concurrency: credit creation (reversal approve) and application (download) both hold the same advisory lock —
 * 194R `R194|<client>|<fy>` (the shipped engine's key), 194C `PAN|<pan>|<fy>`; every write is a guarded UPDATE (appliedPaise + x ≤ amountPaise; release flips releasedAt NULL →
 * now exactly once) backed by SQL CHECKs and the partial unique index on live applications.
 */
import { Prisma, TdsSection } from '@prisma/client';
import { allocateProRataRecovery, computeDeduction } from '../tds/tds-methodology.helper';
import type { TdsRate } from '../tds/tds.helpers';
import { formatINR } from '../common/money';
import { isNoPanKey, payeeKeyFor, retailerKeyOfLedgerPan } from '../tds/tds-194r.shared';
import { r194LockKey } from './r194-lock';
import { financialYear } from '../tds/tds.helpers';

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
  // A 194R no-PAN retailer key (`__NO_PAN__:<partnerId>` / `__NO_PAN__:outlet:…`) is not a PAN — never mask it into one.
  if (isNoPanKey(pan.trim().toUpperCase())) return 'no PAN (higher rate)';
  const p = pan.trim().toUpperCase();
  return p.length >= 5 ? `XXXXX${p.slice(5)}` : p;
}

/** "16 Nov 2026" (IST) — the date wording of every reversal call-out. */
export function istDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

/**
 * Scope of a TDS figure = who the DEDUCTOR is (owner decision D4, 2026-11-16):
 *  - 194C — Gifsy deducts for every programme → the PAN across ALL tenants (Deoleo included): base, ledger and
 *    credits are shared; a credit raised in one programme is used by the next 194C payout on that PAN anywhere.
 *  - 194R — the CLIENT deducts → strictly within that client: base, ledger and credits of other clients never count.
 * Returns the clientId a figure must be restricted to, or null for "all tenants".
 */
export function deductorScopeClientId(section: TdsSection | string, clientId: string): string | null {
  return section === TdsSection.SEC_194C ? null : clientId;
}

/** Is a row of `rowClientId` inside the deductor scope of (section, clientId)? */
export function inDeductorScope(section: TdsSection | string, clientId: string, rowClientId: string | null | undefined): boolean {
  const s = deductorScopeClientId(section, clientId);
  return s === null || rowClientId === s;
}

/** The plain-words scope of a credit (L2): "Scoped to FY 2026-27 · 194C · usable by any programme on this PAN". */
export function creditScopeNote(section: TdsSection | string, fyLabel: string): string {
  return section === TdsSection.SEC_194C
    ? `Scoped to FY ${fyLabel} · 194C · this programme only (used against this programme's next 194C withholding)`
    : `Scoped to FY ${fyLabel} · 194R · this programme only (the client is the deductor)`;
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

/** Credits with something left on the given PANs / sections in one FY, oldest first (FIFO use). Unscoped — the
 *  caller filters them to the deductor scope (inDeductorScope). */
export async function loadOpenTdsCredits(
  db: Prisma.TransactionClient,
  q: { pans: string[]; sections: TdsSection[]; fyLabel: string; clientId?: string },
): Promise<OpenTdsCredit[]> {
  if (q.pans.length === 0 || q.sections.length === 0) return [];
  const rows = await db.tdsCredit.findMany({
    where: {
      panNumber: { in: q.pans },
      section: { in: q.sections },
      fyLabel: q.fyLabel,
      ...(q.clientId ? { clientId: q.clientId } : {}),
    },
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
  /** The credit was raised by another programme (194C only — D4). */
  otherProgramme: boolean;
}

export interface DeductWithCreditsResult {
  /** The figures the ledger records (credit-aware). */
  tdsDueCumulativePaise: bigint;
  carryForwardPaise: bigint;
  /** The TDS due on this payout before any adjustment ("what this payout would have had withheld"). */
  dueThisPaise: bigint;
  /** New cash actually withheld this event = dueThisPaise − handBackPaise − creditAppliedPaise. */
  withheldThisPaise: bigint;
  creditAppliedPaise: bigint;
  /** Of creditAppliedPaise: credits raised by another programme (194C — D4). */
  otherProgrammePaise: bigint;
  /**
   * D3: TDS already deposited this FY on the PAN beyond what the prior base still owes and beyond the explicit
   * credits (a reversal took income off the base, e.g. below the threshold) — the cumulative ledger hands it back on
   * this payout. 0 when `priorDuePaise` is not given. The money is the ledger's, as before; this only explains it.
   */
  handBackPaise: bigint;
  /** Per entry: new withholding (stamped on the entry + ledger), credit used, hand-back. */
  perEntry: Array<{ entryId: string; withheldPaise: bigint; creditPaise: bigint; otherProgrammePaise: bigint; handBackPaise: bigint }>;
  draws: CreditDraw[];
}

/**
 * PURE — one DEDUCT (PAN, section, methodology) group of a download.
 * `priorDeductedPaise` = Σ ledger in the deductor scope; `credits` = the open credits in the deductor scope (the
 * caller filters: 194C any tenant, 194R this tenant) — all usable, oldest first. `priorDuePaise` = the TDS due on
 * the prior base alone (threshold on the prior combined base) — given to compute the hand-back call-out (D3).
 * The withholding is ALWAYS computeDeduction(prior = ledger) split pro-rata — i.e. with no credits it is bit-for-bit
 * the pre-round-B computation; credits and hand-back only explain how it is lower than the TDS due on this payout.
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
  priorDuePaise?: bigint | null;
}): DeductWithCreditsResult {
  const usable = input.credits.filter((c) => outstanding(c) > 0n);
  const usableOutstanding = usable.reduce((s, c) => s + outstanding(c), 0n);
  const base = {
    cumulativeBasePaise: input.cumulativeBasePaise,
    thisPayoutPaise: input.thisPayoutPaise,
    rate: input.rate,
    thresholdMetOnCumulative: input.thresholdMetOnCumulative,
  };
  // What is actually withheld: the cumulative ledger (a credit is a deposit already in it).
  const withC = computeDeduction({ ...base, priorDeductedPaise: input.priorDeductedPaise });
  // As if the credits did not exist (their deposits belong to reversed income).
  const priorNoCredit = input.priorDeductedPaise - usableOutstanding;
  const withoutC = usableOutstanding > 0n ? computeDeduction({ ...base, priorDeductedPaise: priorNoCredit }) : withC;
  // computeDeduction is non-increasing in prior with slope ≥ −1 → 0 ≤ applied ≤ usableOutstanding.
  let applied = withoutC.tdsDeductThisPaise - withC.tdsDeductThisPaise;
  if (applied < 0n) applied = 0n;
  if (applied > usableOutstanding) applied = usableOutstanding;

  // D3: deposits beyond what the prior base still owes (beyond the explicit credits) → handed back here.
  let handBack = 0n;
  let normal = withoutC;
  if (input.priorDuePaise != null) {
    const surplus = priorNoCredit - input.priorDuePaise;
    if (surplus > 0n) {
      normal = computeDeduction({ ...base, priorDeductedPaise: priorNoCredit - surplus });
      handBack = normal.tdsDeductThisPaise - withoutC.tdsDeductThisPaise;
      if (handBack < 0n) {
        handBack = 0n;
        normal = withoutC;
      }
    }
  }
  const due = normal.tdsDeductThisPaise;

  const split = (total: bigint, weights: Map<string, bigint>): Map<string, bigint> => {
    if (total <= 0n) return new Map<string, bigint>();
    const s = allocateProRataRecovery({
      panTdsTotalPaise: total,
      tenants: input.entries.map((e) => ({ clientId: e.id, basePaise: weights.get(e.id) ?? 0n })),
    });
    return new Map(s.map((x): [string, bigint] => [x.clientId, x.tenantSharePaise]));
  };
  const dueBy = split(due, new Map(input.entries.map((e): [string, bigint] => [e.id, e.amountPaise])));
  // The hand-back, then the credit, follow each entry's own TDS due (never more → withheld ≥ 0, Σ exact).
  const hbBy = split(handBack, dueBy);
  const afterHb = new Map(
    input.entries.map((e): [string, bigint] => [e.id, (dueBy.get(e.id) ?? 0n) - (hbBy.get(e.id) ?? 0n)]),
  );
  const creditBy = split(applied, afterHb);

  // FIFO draw of the usable credits (oldest first, any programme in the deductor scope), entry by entry.
  const draws: CreditDraw[] = [];
  const left = usable.map((c) => ({ id: c.id, other: c.clientId !== input.clientId, left: outstanding(c) }));
  const otherBy = new Map<string, bigint>();
  let k = 0;
  for (const e of input.entries) {
    let need = creditBy.get(e.id) ?? 0n;
    while (need > 0n && k < left.length) {
      const take = left[k].left < need ? left[k].left : need;
      if (take > 0n) {
        draws.push({ tdsCreditId: left[k].id, payoutEntryId: e.id, amountPaise: take, otherProgramme: left[k].other });
        if (left[k].other) otherBy.set(e.id, (otherBy.get(e.id) ?? 0n) + take);
        left[k].left -= take;
        need -= take;
      }
      if (left[k].left === 0n) k++;
    }
  }

  const perEntry = input.entries.map((e) => {
    const d = dueBy.get(e.id) ?? 0n;
    const h = hbBy.get(e.id) ?? 0n;
    const c = creditBy.get(e.id) ?? 0n;
    return { entryId: e.id, withheldPaise: d - h - c, creditPaise: c, otherProgrammePaise: otherBy.get(e.id) ?? 0n, handBackPaise: h };
  });

  return {
    tdsDueCumulativePaise: withC.tdsDueCumulativePaise,
    carryForwardPaise: withC.carryForwardPaise,
    dueThisPaise: due,
    withheldThisPaise: due - handBack - applied,
    creditAppliedPaise: applied,
    otherProgrammePaise: [...otherBy.values()].reduce((s, x) => s + x, 0n),
    handBackPaise: handBack,
    perEntry,
    draws,
  };
}

/** The TDS line of one adjusted payout entry (download notice / summary / audit) — one shared wording. */
export function tdsAdjustmentNote(x: { duePaise: bigint; creditPaise: bigint; otherProgrammePaise: bigint; handBackPaise: bigint }): string {
  const withheld = x.duePaise - x.creditPaise - x.handBackPaise;
  const parts = [`TDS due ${formatINR(x.duePaise)}`];
  if (x.handBackPaise > 0n) {
    parts.push(`${formatINR(x.handBackPaise)} less TDS: adjusted after a reversal brought PAN below the limit`);
  }
  const own = x.creditPaise - x.otherProgrammePaise;
  if (own > 0n) parts.push(`${formatINR(own)} adjusted from earlier TDS credit`);
  if (x.otherProgrammePaise > 0n) {
    parts.push(`${formatINR(x.otherProgrammePaise)} adjusted from earlier TDS credit (another programme)`);
  }
  parts.push(`${formatINR(withheld)} withheld from this payout`);
  return parts.join(' · ');
}

/**
 * Download tx: record the draws (one application row each, `clientId` = the paying tenant) and bump the credits'
 * appliedPaise with a guarded UPDATE — a credit can never be used beyond its amount even if the plan were stale, and
 * ONLY by the client that raised it (merge decision 2026-11-19, 194R and 194C alike).
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
  /** Re-audit B7: the CALLER's tenant — the read and the guarded UPDATE are restricted to it (defence in depth). */
  clientId: string,
): Promise<ReleasedApplication[]> {
  if (entryIds.length === 0) return [];
  const live = await tx.tdsCreditApplication.findMany({
    where: { payoutEntryId: { in: entryIds }, releasedAt: null, clientId },
    orderBy: { id: 'asc' },
    select: { id: true, tdsCreditId: true, payoutEntryId: true, amountPaise: true, clientId: true },
  });
  const out: ReleasedApplication[] = [];
  for (const a of live ?? []) {
    const flip = await tx.tdsCreditApplication.updateMany({
      where: { id: a.id, releasedAt: null },
      data: { releasedAt: new Date(), releaseReason: reason },
    });
    if (flip.count !== 1) continue; // released concurrently — nothing to give back twice
    const n = await tx.$executeRaw`UPDATE tds_credits SET "appliedPaise" = "appliedPaise" - ${a.amountPaise}, "updatedAt" = now()
      WHERE id = ${a.tdsCreditId} AND "appliedPaise" >= ${a.amountPaise} AND "clientId" = ${clientId}`; // B7: the caller's tenant
    if (n !== 1) throw new Error(`TDS credit ${a.tdsCreditId} is inconsistent (release of ${a.amountPaise} paise) — contact Gifsy`);
    out.push({ applicationId: a.id, tdsCreditId: a.tdsCreditId, payoutEntryId: a.payoutEntryId, amountPaise: a.amountPaise });
  }
  return out;
}

/**
 * The PAN position the credit cap needs, AFTER the reversed entry left the base (H1). Built by the caller
 * (CreditsService.panPositionForReversal) with exactly the bank download's aggregation rules, in the deductor scope.
 */
export interface PanCreditPosition {
  /** Σ ledger (PAN, section, FY, deductor scope). */
  ledgerPaise: bigint;
  /** Σ outstanding TDS credits in the same scope (before any credit this reversal creates). */
  outstandingCreditsPaise: bigint;
  /** TDS due on the remaining DEDUCT base, threshold tested on the remaining combined base. */
  dueRemainingPaise: bigint;
  /** Threshold met with / without the reversed entry (combined base, + single-payment rule for 194C). */
  thresholdMetBefore: boolean;
  thresholdMetAfter: boolean;
}

export type PanPositionLoader = (q: {
  pan: string;
  section: TdsSection;
  fyLabel: string;
  clientId: string;
  /** The reversed entry's amount — to test the threshold "before" without re-reading it. */
  reversedAmountPaise: bigint;
}) => Promise<PanCreditPosition>;

/**
 * PURE (H1) — the credit a reversed PAID entry may create: what the PAN's cumulative TDS due dropped by, never more
 * than the TDS attributed to that payout (own withholding + earlier credit used for it):
 *   surplus = max(0, Σ ledger − Σ outstanding credits − due(remaining base))
 *   credit  = min(own + earlier, surplus)
 * The rest of own + earlier covers the retailer's other payouts (no credit); surplus beyond the credit is the
 * over-deduction the ledger hands back on the next payout (D3).
 */
export function reversalCreditCap(candidatePaise: bigint, p: PanCreditPosition): {
  creditPaise: bigint;
  coversOtherPayoutsPaise: bigint;
  handBackPaise: bigint;
} {
  let surplus = p.ledgerPaise - p.outstandingCreditsPaise - p.dueRemainingPaise;
  if (surplus < 0n) surplus = 0n;
  const cand = candidatePaise > 0n ? candidatePaise : 0n;
  const credit = cand < surplus ? cand : surplus;
  return { creditPaise: credit, coversOtherPayoutsPaise: cand - credit, handBackPaise: surplus - credit };
}

export interface ReceivableTdsOutcome {
  /** Net cash the retailer actually received = the receivable recorded. */
  receivablePaise: bigint;
  /** TDS that stays deposited and became a credit on the PAN (0 → none created). */
  tdsCreditPaise: bigint;
  tdsCreditId: string | null;
  panMasked: string | null;
  /** Of the credit candidate: the entry's own withholding / earlier credit that had been applied to this payout. */
  ownWithheldPaise: bigint;
  earlierCreditPaise: bigint;
  /** H1: part of own + earlier that covers the retailer's other payouts (catch-up TDS) — no credit. */
  coversOtherPayoutsPaise: bigint;
  /** D3: TDS deposited on the PAN beyond what is now due, handed back on the next payout on the PAN. */
  handBackPaise: bigint;
  /** D1: the PAN fell below the TDS threshold for the FY because of this reversal. */
  belowThresholdAfterReversal: boolean;
  /** Withheld on the entry but not traceable to a PAN in the TDS ledger (e.g. imported history) — no credit. */
  untrackedWithheldPaise: bigint;
  /** A5 / re-audit A1: what would have been a credit but could never be used — left as the report's flagged excess. */
  flaggedExcessPaise: bigint;
  /** Why it could not be used (closed FY / gross-up / PAN changed); null when nothing was left uncredited. */
  flaggedExcessReason: string | null;
  note: string;
}

/**
 * The advisory-lock keys an entry's receivable / reversal credit needs (read-only), taken by the approve BEFORE any
 * entry is processed, all sorted together (deadlock-free against downloads and other approvals).
 *
 * Every PAID entry that reaches here is 194R: owner D1 (2026-11-19) refuses a PAID 194C reversal earlier, and an
 * incentive payout with no frozen section IS 194R in the base (effectiveEntrySection — audit A2), so it takes the
 * same keys as the shipped 194R engine: `R194|client|FY` for the FY whose base the entry counts in (its bank-file FY),
 * every FY its withholding was booked in, and the FY of any credit it used.
 */
export async function receivablePanLockKeys(
  tx: Prisma.TransactionClient,
  e: { id: string; clientId: string; outletId: string; period: string; tdsSection?: TdsSection | null; baseFyLabel?: string },
): Promise<string[]> {
  const fys = new Set<string>([e.baseFyLabel ?? fyLabelOf(e.period)]);
  const ledger = await tx.tdsDeductionEntry.findMany({
    where: { creditPayoutEntryId: e.id },
    select: { fyLabel: true },
  });
  for (const r of ledger ?? []) if (r.fyLabel) fys.add(r.fyLabel);
  const apps = await tx.tdsCreditApplication.findMany({
    where: { payoutEntryId: e.id, releasedAt: null },
    select: { tdsCredit: { select: { fyLabel: true } } },
  });
  for (const a of apps ?? []) if (a.tdsCredit?.fyLabel) fys.add(a.tdsCredit.fyLabel);
  return [...fys].map((fy) => r194LockKey(e.clientId, fy));
}

/**
 * Audit B6 (same rule on the approve path): the lock keys of the LIVE credit applications of `entryIds` — cancelling
 * such an entry releases the credit it used, so it takes that credit's key even when the entry carries no withholding
 * (a credit covered it). 194R → `R194|client|FY` of the credit's FY; 194C (none created any more — owner D1) → its PAN key.
 */
export async function creditLockKeysOfEntries(
  tx: Prisma.TransactionClient,
  clientId: string,
  entryIds: string[],
): Promise<string[]> {
  if (entryIds.length === 0) return [];
  const apps = await tx.tdsCreditApplication.findMany({
    where: { payoutEntryId: { in: entryIds }, releasedAt: null },
    select: { tdsCredit: { select: { section: true, panNumber: true, fyLabel: true } } },
  });
  const keys = new Set<string>();
  for (const a of apps ?? []) {
    const c = a.tdsCredit;
    if (!c?.fyLabel) continue;
    if (c.section === TdsSection.SEC_194C) {
      if (c.panNumber?.trim()) keys.add(panLockKey(c.panNumber.trim().toUpperCase(), c.fyLabel));
    } else {
      keys.add(r194LockKey(clientId, c.fyLabel));
    }
  }
  return [...keys];
}

/** 194R: the outlet's retailer key today (payeeKeyFor — the same rule the bank-file snapshot uses). */
async function currentRetailerKeyOfOutlet(
  tx: Prisma.TransactionClient,
  clientId: string,
  outletCode: string,
): Promise<string> {
  const o = await tx.outlet.findFirst({
    where: { clientId, outletCode },
    select: { partner: { select: { id: true, panNumber: true } } },
  });
  return payeeKeyFor(clientId, outletCode, o?.partner ?? null);
}

/** The entry's own withholding as booked: net Σ, and the PAN + FY of its newest POSITIVE row. */
async function ledgerOfEntry(
  tx: Prisma.TransactionClient,
  entryId: string,
): Promise<{ net: bigint; pan: string | null; fyLabel: string | null }> {
  const ledger = await tx.tdsDeductionEntry.findMany({
    where: { creditPayoutEntryId: entryId },
    orderBy: { createdAt: 'desc' },
    select: { panNumber: true, tdsDeductedThisPaise: true, fyLabel: true },
  });
  const net = (ledger ?? []).reduce((s, r) => s + r.tdsDeductedThisPaise, 0n);
  const pos = (ledger ?? []).find((r) => r.tdsDeductedThisPaise > 0n && r.panNumber?.trim());
  return { net, pan: pos?.panNumber ?? null, fyLabel: pos?.fyLabel ?? null };
}

/**
 * V2 approve of a PAID 194R entry (the caller holds the batch lock, the entry row lock and — via
 * receivablePanLockKeys — the `R194|client|FY` locks). Decides the receivable, takes the entry off the yearly 194R base
 * (D1) and creates the TDS credit:
 *  - receivable = amount − tdsDeductedPaise (net cash received); a payout FULLY withheld as TDS (`fullyWithheld`,
 *    owner D2 2026-11-19) reached the retailer as ₹0 → receivable 0, the caller marks the entry REVERSED;
 *  - the entry is marked `tdsBaseReversedAt` (every PAID reversal, with or without TDS) — collect194RBases leaves it
 *    out (payout engine + 194R report alike);
 *  - credit candidate = the entry's own withholding as booked in the TDS ledger (net Σ for the entry, capped at the
 *    stamp) + any earlier credit that had been applied to this payout; credit = min(candidate, the drop in the TDS due)
 *    (H1, reversalCreditCap — the report's own liability194R deduct part on the remaining base);
 *  - audit A5: a credit is created ONLY while the client's CURRENT 194R method is DEDUCT (only then is 194R withheld
 *    again, so only then can it ever be used). On GROSS_UP the withheld TDS stays where it is — the 194R report flags
 *    it as TDS taken in excess — and the outcome says so;
 *  - the credit is keyed on the ledger row's own key (the payee snapshot key at withholding) and lives in the ledger
 *    row's FY; it is used only by this client;
 *  - nothing withheld → no credit; withheld but untraceable → no credit, called out.
 * One credit per entry (`sourcePayoutEntryId` unique).
 */
export async function recordReceivableTds(
  tx: Prisma.TransactionClient,
  e: {
    id: string;
    clientId: string;
    outletId: string;
    amountPaise: bigint;
    period: string;
    tdsSection: TdsSection | null;
    tdsMethodology: string | null;
    tdsDeductedPaise: bigint;
    /** The payee snapshot written when the payout went into a bank file (null → current owner). */
    payeePan?: string | null;
    /** The FY whose 194R base the entry counts in (its bank-file FY). */
    baseFyLabel?: string;
    /** Owner D2: the whole payout was withheld as TDS (nothing reached the retailer). */
    fullyWithheld?: boolean;
  },
  ctx: {
    creditReversalId: string;
    actorId: string;
    panPosition: PanPositionLoader;
    /** The client's CURRENT 194R method (audit A5). */
    currentMethodology: string;
    /** Test hook: "now" for the current-FY usability test (defaults to the real clock). */
    now?: Date;
  },
): Promise<ReceivableTdsOutcome> {
  if (e.tdsSection === TdsSection.SEC_194C) {
    // Owner D1: refused before this point (assertNoPaid194C) — never create a 194C credit or move a 194C base.
    throw new Error(`Payout entry ${e.id} is a PAID 194C payout — ${'194C payouts cannot be reversed once paid'}`);
  }
  const section = TdsSection.SEC_194R; // a null frozen section on a PAID incentive payout is 194R (A2)
  const withheld = e.tdsDeductedPaise > 0n ? e.tdsDeductedPaise : 0n;
  const net = e.amountPaise - withheld;
  const receivablePaise = e.fullyWithheld || net < 0n ? 0n : net;
  const led = await ledgerOfEntry(tx, e.id);
  const ledgerKey = led.pan ? retailerKeyOfLedgerPan(led.pan) : null;
  const ownWithheld = ledgerKey && withheld > 0n ? (led.net < withheld ? (led.net > 0n ? led.net : 0n) : withheld) : 0n;
  const untracked = withheld - ownWithheld;

  const apps = await tx.tdsCreditApplication.findMany({
    where: { payoutEntryId: e.id, releasedAt: null },
    select: { amountPaise: true, tdsCredit: { select: { panNumber: true, fyLabel: true } } },
  });
  const earlier = (apps ?? []).reduce((s, a) => s + a.amountPaise, 0n);
  const appCredit = (apps ?? []).find((a) => a.tdsCredit?.panNumber)?.tdsCredit ?? null;
  const pan = ledgerKey ?? (appCredit?.panNumber ? retailerKeyOfLedgerPan(appCredit.panNumber) : null);
  const baseFy = e.baseFyLabel ?? fyLabelOf(e.period);
  // The credit lives in the FY its TDS was booked in (the ledger row's FY); a credit-only payout → that credit's FY.
  const creditFy = led.fyLabel ?? appCredit?.fyLabel ?? baseFy;

  // D1: the income was reversed → it leaves the yearly base (guarded: exactly once per entry). RAW UPDATE on purpose:
  // the entry is PAID, and a Prisma update would bump its @updatedAt — the Daily Ops Digest counts PAID payouts by
  // updatedAt, so an old payment would be re-counted as paid today (digest-recorded-time-guard.spec.ts, reviewed site).
  // "clientId" in the WHERE is defence in depth (audit B7).
  const marked = await tx.$executeRaw`UPDATE "credit_payout_entries" SET "tdsBaseReversedAt" = ${new Date()}, "tdsBaseReversalId" = ${ctx.creditReversalId} WHERE "id" = ${e.id} AND "clientId" = ${e.clientId} AND "tdsBaseReversedAt" IS NULL`;
  if (marked !== 1) {
    throw new Error(`Payout entry ${e.id} was already taken off the TDS base by another reversal — contact Gifsy`);
  }

  // The position AFTER the base left, under the key the base counted under: the deducted-under key, else the payee
  // snapshot taken when the payout went into its bank file, else the outlet's owner today (audit A2: the note cites
  // exactly this key and the bank-file FY).
  const capPan = pan ?? (e.payeePan?.trim() ? e.payeePan.trim() : await currentRetailerKeyOfOutlet(tx, e.clientId, e.outletId));
  const posFy = pan ? creditFy : baseFy;
  const position = await ctx.panPosition({
    pan: capPan, section, fyLabel: posFy, clientId: e.clientId, reversedAmountPaise: e.amountPaise,
  });
  const candidate = pan ? ownWithheld + earlier : 0n;
  const deduct = ctx.currentMethodology === 'DEDUCT';
  const cap = reversalCreditCap(candidate, position);
  // Re-audit A1 (2026-11-19): a credit is created only when it is USABLE at creation — the SAME three conditions the
  // payout run uses a credit under (and the 194R report subtracts it under): (a) its FY is the current, open FY (the
  // run only reads the run date's FY); (b) the client's current method is DEDUCT (only then is 194R withheld again);
  // (c) its key is the key this retailer's future payouts use (the run looks credits up by the CURRENT payee key).
  // Choice: an unusable credit is NOT created (nothing would ever draw it, and a credit row that silently cannot be
  // used would only hide the excess). The withheld TDS stays in the ledger, where the 194R report counts it as excess
  // (owner rule: flag only) — the outcome says exactly that and why.
  const currentFy = financialYear(ctx.now ?? new Date()).fyLabel;
  const currentKey = pan ? await currentRetailerKeyOfOutlet(tx, e.clientId, e.outletId) : null;
  const unusableReason: string | null = !pan
    ? null
    : creditFy !== currentFy
      ? `the TDS was withheld in FY ${creditFy}, which is closed (later-year reversal) — no later withholding of FY ${creditFy} can use it`
      : !deduct
        ? "this programme's 194R method is now gross-up — no TDS is withheld that it could reduce"
        : currentKey !== pan
          ? `the retailer's PAN has changed since (TDS was withheld under ${maskPan(pan)}, payouts now go under ${maskPan(currentKey ?? '')})`
          : null;
  const credit = unusableReason ? 0n : cap.creditPaise;
  const flaggedExcess = unusableReason ? cap.creditPaise : 0n;
  const below = position.thresholdMetBefore && !position.thresholdMetAfter;
  const panM = maskPan(capPan);
  const who = isNoPanKey(capPan.toUpperCase()) ? 'this no-PAN retailer' : `PAN ${panM}`;

  const extra: string[] = [];
  extra.push(`${formatINR(e.amountPaise)} taken off ${who}'s FY ${posFy} 194R base (the FY of its bank file).`);
  if (below) extra.push(`${who} is below the TDS threshold for FY ${posFy} after this reversal.`);
  if (cap.coversOtherPayoutsPaise > 0n) {
    extra.push(`${formatINR(cap.coversOtherPayoutsPaise)} of this TDS covers the retailer's other payouts — no credit.`);
  }
  if (flaggedExcess > 0n) {
    // Re-audit A5: honest about what happens to it — it stays in the 194R ledger of its FY. If (and only if) the
    // programme withholds 194R again for this retailer in that same FY, the whole-year true-up nets it automatically
    // (the 194R report shows that as "netted"); otherwise the report flags it as TDS taken in excess.
    extra.push(
      creditFy !== currentFy
        ? `${formatINR(flaggedExcess)} withheld TDS is not turned into a credit: ${unusableReason}. It stays deposited in ` +
            `FY ${creditFy}'s 194R ledger and the FY ${creditFy} 194R report flags it as TDS taken in excess (no automatic ` +
            'refund — the retailer can claim it in that year\'s return).'
        : `${formatINR(flaggedExcess)} withheld TDS is not turned into a credit: ${unusableReason}. It stays deposited and ` +
            `in the 194R ledger of FY ${creditFy}: if this programme withholds 194R from this retailer again in FY ${creditFy} ` +
            '(e.g. after switching back to deduct), the year\'s true-up nets it automatically and the 194R report says so; ' +
            'otherwise the 194R report flags it as TDS taken in excess (no automatic refund).',
    );
  }
  if (cap.handBackPaise > 0n && deduct) {
    extra.push(
      `${formatINR(cap.handBackPaise)} TDS already withheld from ${who} is more than now due — the next payout of this ` +
        `programme on it withholds that much less (adjusted after a reversal brought it below the limit).`,
    );
  }
  if (untracked > 0n) {
    extra.push(`${formatINR(untracked)} TDS on this entry is not in Gifsy's TDS ledger (e.g. imported history or no PAN) — no credit for it; correct it off-platform.`);
  }
  const tail = extra.length ? ` ${extra.join(' ')}` : '';
  const common = {
    receivablePaise,
    ownWithheldPaise: ownWithheld,
    earlierCreditPaise: earlier,
    coversOtherPayoutsPaise: cap.coversOtherPayoutsPaise,
    handBackPaise: deduct ? cap.handBackPaise : 0n,
    belowThresholdAfterReversal: below,
    untrackedWithheldPaise: untracked,
    flaggedExcessPaise: flaggedExcess,
    flaggedExcessReason: unusableReason,
  };
  const owedText = e.fullyWithheld
    ? 'The whole payout had been withheld as TDS — nothing reached the retailer, nothing owed.'
    : `Receivable = net received ${formatINR(receivablePaise)}.`;

  if (credit <= 0n || !pan) {
    const isGrossUp = e.tdsMethodology === 'GROSS_UP';
    return {
      ...common,
      tdsCreditPaise: 0n,
      tdsCreditId: null,
      panMasked: panM,
      note:
        (isGrossUp
          ? 'No TDS was withheld from the retailer (gross-up: the program paid the TDS on top) — receivable = amount paid, no TDS credit.'
          : withheld === 0n
            ? 'No TDS was withheld on this entry — receivable = amount paid, no TDS credit.'
            : `${owedText} No TDS credit.`) + tail,
    };
  }

  const created = await tx.tdsCredit.create({
    data: {
      clientId: e.clientId,
      panNumber: pan,
      section,
      fyLabel: creditFy,
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
    ...common,
    tdsCreditPaise: credit,
    tdsCreditId: created.id,
    panMasked: panM,
    note:
      `${owedText} ${formatINR(credit)} TDS credit carried forward on ${who} (of ${parts.join(' + ')}) — it stays deposited ` +
      `with the government and is adjusted against this programme's next 194R TDS for it in FY ${creditFy}, so it is ` +
      `never deducted twice (scoped to FY ${creditFy}; not carried into the next FY).` +
      tail,
  };
}
