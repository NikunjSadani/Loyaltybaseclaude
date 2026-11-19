/**
 * PAYOUT (₹) reversals under the Wallet Reversal Engine — WP5 (WALLET-REVERSAL-ENGINE-DESIGN.md §8, Q9–Q11).
 *
 * Active for a tenant whose `reversalEngine` flag is V2 (owner 2026-11-16: SHADOW behaves exactly like LEGACY for
 * PAYOUT reversals; LEGACY — the default, Deoleo — never reaches
 * this module at create time; see CreditsService.createReversal). The rules:
 *  P1 entry-targeted: the request names the WHOLE payout entries it reverses (operator picks them; the UI
 *     preselects every open entry of the (batch, outlet, field)); requested = Σ selected (Q9).
 *  P2 reservation at create: one RESERVED PayoutReversalAllocation per entry. The partial unique index
 *     `payout_reversal_allocations_payoutEntryId_live_key` makes it impossible for an entry to sit in two live
 *     reversals; a rejection RELEASES the rows.
 *  P3 bank downloads / re-bank skip RESERVED entries (Q10) — CreditsService.createPayoutDownload.
 *  P4 approve (batch lock → entries FOR UPDATE ascending id): PENDING/FAILED → entry REVERSED + its DEDUCT
 *     withholding offset once → APPLIED_CANCELLED; PROCESSING → refused (the file is with the bank); PAID → the
 *     entry stays PAID, its amount is a receivable → APPLIED_RECEIVABLE (Q11: recorded only).
 *  P5 the cap is structural (an entry can be allocated once). P6 shortfall = Σ receivables.
 *
 * Which reversals take this path at APPROVE/REJECT is decided by the data, not the flag: a PAYOUT reversal that
 * holds allocation rows was raised under the engine; one without (raised under LEGACY, or before the engine) keeps
 * the interim whole-entry path. So flipping a tenant's flag back to LEGACY never strands a reservation.
 *
 * `planPayoutAllocationBackfill` (bottom) is the PURE planner that turns the PAYOUT reversals approved before the
 * engine into allocation rows (§8 "Backfill existing PAYOUT reversals; ambiguous → flagged") — see its doc.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CreditEntryStatus, PayoutAllocationState, Prisma, TdsSection } from '@prisma/client';
import { formatINR } from '../common/money';
import {
  receivablePanLockKeys,
  recordReceivableTds,
  releaseCreditApplications,
  type PanPositionLoader,
} from './tds-credit';

/** Allocation states that hold an entry (the partial unique index's predicate). RELEASED does not. */
export const LIVE_PAYOUT_ALLOCATION_STATES: PayoutAllocationState[] = [
  'RESERVED',
  'APPLIED_CANCELLED',
  'APPLIED_RECEIVABLE',
];

/** The entry statuses a reversal may still act on (REVERSED is terminal). */
const REVERSIBLE_STATUSES: CreditEntryStatus[] = ['PENDING', 'PROCESSING', 'PAID', 'FAILED'];

export interface PayoutReversalKey {
  clientId: string;
  batchId: string;
  outletId: string;
  fieldId: string;
}

/** Why an entry of the (batch, outlet, field) cannot be selected for a new reversal. */
export type PayoutCandidateBlock =
  | 'REVERSED' // already clawed back (terminal)
  | 'RESERVED' // held by a pending reversal
  | 'CONSUMED' // taken by an approved reversal (cancelled, or recorded as a receivable)
  | 'ZERO'; // a zero-amount entry has nothing to reverse

export interface PayoutCandidateEntry {
  id: string;
  amountPaise: bigint;
  status: CreditEntryStatus | string;
  period: string;
  createdAt: Date;
  tdsDeductedPaise: bigint | null;
  tdsSection: string | null;
  outletId: string;
}

export interface PayoutReversalCandidate extends PayoutCandidateEntry {
  selectable: boolean;
  blockedBy: PayoutCandidateBlock | null;
  /** The live reversal holding the entry (RESERVED / CONSUMED via an allocation row). */
  heldByReversalId: string | null;
}

export interface LiveAllocationRow {
  payoutEntryId: string;
  creditReversalId: string;
  state: PayoutAllocationState | string;
}

export interface ApprovedPayoutReversalRow {
  consumedPayoutEntryIds: unknown;
  approvedAt: Date | null;
  approvedPaise: bigint | null;
}

/**
 * PURE — classify the entries of one (batch, outlet, field) for a NEW reversal.
 * "Consumed" mirrors the interim rule (CreditsService.selectPayoutEntriesForReversal) so the engine never
 * re-takes what an interim/legacy approval took: (a) ids in `consumedPayoutEntryIds` of an APPROVED/PARTIAL PAYOUT
 * reversal; (b) for approvals from before that column existed (null), every PAID entry created on or before the
 * approval. Plus (c) any live allocation row (engine reversals — RESERVED while pending).
 */
export function classifyPayoutCandidates(
  entries: PayoutCandidateEntry[],
  liveAllocations: LiveAllocationRow[],
  approvedReversals: ApprovedPayoutReversalRow[],
): PayoutReversalCandidate[] {
  const consumed = new Set<string>();
  let legacyCutoff: number | null = null;
  for (const a of approvedReversals) {
    if (Array.isArray(a.consumedPayoutEntryIds)) {
      for (const x of a.consumedPayoutEntryIds) if (typeof x === 'string') consumed.add(x);
    } else if (a.approvedAt instanceof Date && (a.approvedPaise ?? 0n) > 0n) {
      legacyCutoff = Math.max(legacyCutoff ?? 0, a.approvedAt.getTime());
    }
  }
  const live = new Map<string, LiveAllocationRow>();
  for (const al of liveAllocations) {
    if ((LIVE_PAYOUT_ALLOCATION_STATES as string[]).includes(String(al.state))) live.set(al.payoutEntryId, al);
  }
  return entries.map((e) => {
    const al = live.get(e.id) ?? null;
    let blockedBy: PayoutCandidateBlock | null = null;
    if (e.status === 'REVERSED') blockedBy = 'REVERSED';
    else if (al && al.state === 'RESERVED') blockedBy = 'RESERVED';
    else if (al) blockedBy = 'CONSUMED';
    else if (consumed.has(e.id)) blockedBy = 'CONSUMED';
    else if (
      legacyCutoff !== null &&
      e.status === 'PAID' &&
      e.createdAt instanceof Date &&
      e.createdAt.getTime() <= legacyCutoff
    ) {
      blockedBy = 'CONSUMED';
    } else if (e.amountPaise <= 0n) blockedBy = 'ZERO';
    else if (!(REVERSIBLE_STATUSES as string[]).includes(String(e.status))) blockedBy = 'CONSUMED';
    return { ...e, selectable: blockedBy === null, blockedBy, heldByReversalId: al?.creditReversalId ?? null };
  });
}

/** Read the (batch, outlet, field)'s entries + everything that blocks them, and classify. */
export async function loadPayoutReversalCandidates(
  tx: Prisma.TransactionClient,
  key: PayoutReversalKey,
): Promise<PayoutReversalCandidate[]> {
  const entries = await tx.creditPayoutEntry.findMany({
    where: { clientId: key.clientId, batchId: key.batchId, outletId: key.outletId, fieldId: key.fieldId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      amountPaise: true,
      status: true,
      period: true,
      createdAt: true,
      tdsDeductedPaise: true,
      tdsSection: true,
      outletId: true,
    },
  });
  const ids = entries.map((e) => e.id);
  const liveAllocations =
    ids.length > 0
      ? await tx.payoutReversalAllocation.findMany({
          where: { payoutEntryId: { in: ids }, state: { in: LIVE_PAYOUT_ALLOCATION_STATES } },
          select: { payoutEntryId: true, creditReversalId: true, state: true },
        })
      : [];
  const approved = await tx.creditReversal.findMany({
    where: {
      clientId: key.clientId,
      outletId: key.outletId,
      fieldId: key.fieldId,
      awardType: 'PAYOUT',
      status: { in: ['APPROVED', 'PARTIAL'] },
    },
    select: { consumedPayoutEntryIds: true, approvedAt: true, approvedPaise: true },
  });
  return classifyPayoutCandidates(
    entries.map((e) => ({ ...e, tdsSection: e.tdsSection ?? null, tdsDeductedPaise: e.tdsDeductedPaise ?? 0n })),
    liveAllocations,
    approved,
  );
}

const BLOCK_TEXT: Record<PayoutCandidateBlock, string> = {
  REVERSED: 'already reversed',
  RESERVED: 'held by another pending reversal',
  CONSUMED: 'already taken by an approved reversal',
  ZERO: 'has no amount',
};

/** Row-lock the given entries in ascending id order (§5 lock order: credit_batches → … → credit_payout_entries). */
async function lockEntries(tx: Prisma.TransactionClient, clientId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const sorted = [...ids].sort();
  await tx.$queryRaw`SELECT id FROM credit_payout_entries WHERE "clientId" = ${clientId} AND id IN (${Prisma.join(sorted)}) ORDER BY id FOR UPDATE`;
}

/**
 * CREATE (P1): validate the operator's selection. The caller holds the batch row lock. Locks the selected entries,
 * re-reads them, and requires every id to be a selectable entry of this (batch, outlet, field) and Σ amounts to
 * equal the requested amount (the client sends both so a stale screen can't request a different sum). Returns the
 * chosen entries in ascending id order.
 */
export async function selectPayoutEntriesV2(
  tx: Prisma.TransactionClient,
  key: PayoutReversalKey,
  entryIds: string[] | undefined,
  requestedPaise: bigint,
): Promise<PayoutReversalCandidate[]> {
  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    throw new BadRequestException(
      'Select the payout entries to reverse (payoutEntryIds) — a payout reversal covers whole payout entries',
    );
  }
  if (new Set(entryIds).size !== entryIds.length) {
    throw new BadRequestException('A payout entry is selected more than once');
  }
  await lockEntries(tx, key.clientId, entryIds);
  const candidates = await loadPayoutReversalCandidates(tx, key);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const chosen: PayoutReversalCandidate[] = [];
  for (const id of entryIds) {
    const c = byId.get(id);
    if (!c) {
      throw new BadRequestException(`Payout entry ${id} is not an entry of this outlet and field in this batch`);
    }
    if (!c.selectable) {
      throw new BadRequestException(
        `Payout entry ${formatINR(c.amountPaise)} (${id}) cannot be reversed: it is ${BLOCK_TEXT[c.blockedBy!]}`,
      );
    }
    chosen.push(c);
  }
  const sum = chosen.reduce((s, c) => s + c.amountPaise, 0n);
  if (sum !== requestedPaise) {
    throw new BadRequestException(
      `The requested amount (${formatINR(requestedPaise)}) must equal the selected payout entries (${formatINR(sum)})`,
    );
  }
  return chosen.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** CREATE (P2): reserve the chosen entries for the freshly-created reversal. */
export async function reservePayoutEntries(
  tx: Prisma.TransactionClient,
  creditReversalId: string,
  chosen: Pick<PayoutReversalCandidate, 'id' | 'amountPaise' | 'status'>[],
  audit: PayoutReversalKey & { actorId: string; remarks?: string | null },
): Promise<void> {
  try {
    await tx.payoutReversalAllocation.createMany({
      data: chosen.map((c) => ({
        creditReversalId,
        payoutEntryId: c.id,
        amountPaise: c.amountPaise,
        state: 'RESERVED' as const,
      })),
    });
  } catch (e) {
    // Partial unique index on live allocations: another reversal holds one of these entries. Unreachable while
    // the batch lock + entry locks are held (defence in depth) — never translate it to the "duplicate pending
    // reversal" message the caller uses for its own P2002.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new BadRequestException('A selected payout entry is already held by another reversal — reload and retry');
    }
    throw e;
  }
  await auditPayoutReversal(tx, {
    action: 'CREATE',
    creditReversalId,
    actorId: audit.actorId,
    metadata: {
      step: 'RESERVED',
      clientId: audit.clientId,
      batchId: audit.batchId,
      outletId: audit.outletId,
      fieldId: audit.fieldId,
      totalPaise: chosen.reduce((n, c) => n + c.amountPaise, 0n),
      entries: chosen.map((c) => ({ entryId: c.id, amountPaise: c.amountPaise, status: c.status })),
      remarks: audit.remarks ?? null,
    },
  });
}

/** The CreditReversal fields the approve/reject path needs. */
export interface PayoutReversalRow {
  id: string;
  clientId: string;
  batchId: string;
  outletId: string;
  fieldId: string;
  requestedPaise: bigint;
}

export interface PatchPayoutV2Deps {
  /** CreditsService.offsetWithholdingOnReversal bound to this tx + tenant (idempotent per entry). */
  offsetWithholding: (e: {
    id: string;
    outletId: string;
    period: string;
    tdsSection: TdsSection;
    tdsDeductedPaise: bigint;
  }) => Promise<bigint>;
  /** Fix round B (H1): the PAN's TDS position after a reversed PAID entry left the base (CreditsService). */
  panPosition: PanPositionLoader;
}

/**
 * The approve/reject OUTCOME SUMMARY of a PAYOUT reversal (owner decision 3, 2026-11-16 — every tenant, display
 * only). `headline` + `lines` are the plain-words call-outs the payout screen shows; the arrays keep the WP5 detail.
 */
export interface PayoutOutcome {
  headline?: string;
  lines: Array<{ kind: 'CANCELLED' | 'RECEIVABLE' | 'RELEASED' | 'ALREADY_REVERSED' | 'NOTHING'; entryId: string | null; text: string }>;
  cancelled: Array<{ entryId: string; amountPaise: number; wasStatus: string; tdsOffsetPaise: number; tdsNote: string }>;
  receivable: Array<{
    entryId: string;
    /** The entry's gross amount (integer paise). */
    amountPaise: number;
    /** The receivable recorded = net cash received (V2) / the full amount (LEGACY, unchanged rule). */
    receivablePaise: number;
    tdsCreditPaise: number;
    panMasked: string | null;
    tdsNote: string;
    /** Fix round B (V2 only; absent on LEGACY): H1 / D3 / D1 detail. */
    tdsWithheldPaise?: number;
    coversOtherPayoutsPaise?: number;
    handBackPaise?: number;
    belowThresholdAfterReversal?: boolean;
  }>;
  /** Σ receivable recorded (integer paise) = CreditReversal.shortfallPaise. */
  receivablePaise: number;
  /** Σ TDS credit created (V2 only; 0 on LEGACY). */
  tdsCreditPaise: number;
  released: Array<{ entryId: string; amountPaise: number }>;
}

/** "Approved · 1 entry cancelled (₹5,000) · ₹9,800 recorded as owed · ₹200 TDS credit carried forward". */
export function approvedHeadline(o: PayoutOutcome): string {
  const parts = ['Approved'];
  if (o.cancelled.length > 0) {
    const t = o.cancelled.reduce((n, c) => n + c.amountPaise, 0);
    parts.push(`${o.cancelled.length} entr${o.cancelled.length === 1 ? 'y' : 'ies'} cancelled (${formatINR(BigInt(t))}) — will not be paid`);
  }
  if (o.receivable.length > 0) {
    // L3: a payout fully withheld as TDS leaves nothing owed — say so instead of a bare "₹0 recorded as owed".
    parts.push(
      o.receivablePaise > 0
        ? `${formatINR(BigInt(o.receivablePaise))} recorded as owed`
        : `${formatINR(0n)} owed — the whole amount paid was withheld as TDS`,
    );
  }
  if (o.tdsCreditPaise > 0) parts.push(`${formatINR(BigInt(o.tdsCreditPaise))} TDS credit carried forward`);
  if (o.cancelled.length === 0 && o.receivable.length === 0) parts.push('no payout entry changed');
  return parts.join(' · ');
}

/**
 * L5 — THE one wording of a reversed PAID entry's outcome (V2), shared by the approve outcome line, the audit row
 * and the reports: net amount owed, TDS withheld, TDS credit (or why none), H1 / D3 / D1 call-outs.
 */
export function paidEntryOutcomeText(x: {
  amountPaise: bigint;
  receivablePaise: bigint;
  tdsWithheldPaise: bigint;
  tdsCreditPaise: bigint;
  panMasked: string | null;
  methodology: string | null;
  untrackedWithheldPaise: bigint;
  coversOtherPayoutsPaise: bigint;
  handBackPaise: bigint;
  belowThresholdAfterReversal: boolean;
}): string {
  const owed =
    x.receivablePaise > 0n
      ? `Recorded as owed · ${formatINR(x.receivablePaise)}` +
        (x.tdsWithheldPaise > 0n ? ` (net of ${formatINR(x.tdsWithheldPaise)} TDS withheld from ${formatINR(x.amountPaise)})` : '')
      : `Nothing owed · the whole ${formatINR(x.amountPaise)} was withheld as TDS`;
  const parts = [owed];
  if (x.tdsCreditPaise > 0n) parts.push(`${formatINR(x.tdsCreditPaise)} TDS credit carried forward on PAN ${x.panMasked}`);
  else if (x.methodology === 'GROSS_UP') parts.push('no TDS was withheld from the retailer (the program paid it on top) — no TDS credit');
  else if (x.tdsWithheldPaise === 0n) parts.push('no TDS withheld — no TDS credit');
  else if (x.coversOtherPayoutsPaise === 0n) parts.push('no TDS credit');
  if (x.coversOtherPayoutsPaise > 0n) {
    parts.push(`${formatINR(x.coversOtherPayoutsPaise)} of this TDS covers the retailer's other payouts — no credit`);
  }
  if (x.belowThresholdAfterReversal) parts.push(`PAN ${x.panMasked} now below the TDS threshold`);
  if (x.handBackPaise > 0n) {
    parts.push(`${formatINR(x.handBackPaise)} over-deducted TDS handed back on the next payout on PAN ${x.panMasked}`);
  }
  if (x.untrackedWithheldPaise > 0n) {
    parts.push(`${formatINR(x.untrackedWithheldPaise)} TDS not in Gifsy's TDS ledger — correct it off-platform`);
  }
  return parts.join(' · ');
}

export const SENT_TO_BANK_MESSAGE =
  'Payment already sent to the bank for this outlet and field (payout file downloaded, not yet reconciled) — record the UTR or the failure first, then approve the reversal';

/**
 * APPROVE / REJECT (P2 release, P4) for a PAYOUT reversal that holds allocation rows. Returns null when it holds
 * none (→ the caller runs the interim path unchanged). The caller holds the batch row lock on approve and has
 * already checked the Σ cap. Everything below runs inside the caller's transaction.
 */
export async function patchPayoutReversalV2(
  tx: Prisma.TransactionClient,
  deps: PatchPayoutV2Deps,
  reversal: PayoutReversalRow,
  p: {
    action: 'approve' | 'reject';
    newStatus: 'APPROVED' | 'PARTIAL' | 'REJECTED';
    finalApprovedPaise: bigint | null;
    remarks: string | null;
    actorId: string;
  },
): Promise<Record<string, unknown> | null> {
  const allocations = await tx.payoutReversalAllocation.findMany({
    where: { creditReversalId: reversal.id },
    orderBy: { payoutEntryId: 'asc' },
  });
  if (allocations.length === 0) return null;

  if (p.action === 'reject') {
    const claimed = await tx.creditReversal.updateMany({
      where: { id: reversal.id, status: 'PENDING_GIFSY' },
      data: { status: 'REJECTED', approvedPaise: null, approvedBy: p.actorId, approvedAt: new Date(), remarks: p.remarks },
    });
    if (claimed.count === 0) throw new BadRequestException('Reversal already processed');
    // P2: the entries are free again (next download / a new reversal may take them).
    await tx.payoutReversalAllocation.updateMany({
      where: { creditReversalId: reversal.id, state: 'RESERVED' },
      data: { state: 'RELEASED' },
    });
    const released = allocations
      .filter((a) => a.state === 'RESERVED')
      .map((a) => ({ entryId: a.payoutEntryId, amountPaise: Number(a.amountPaise) }));
    await auditPayoutReversal(tx, {
      action: 'REJECT',
      creditReversalId: reversal.id,
      actorId: p.actorId,
      metadata: { step: 'RELEASED', clientId: reversal.clientId, batchId: reversal.batchId, outletId: reversal.outletId, fieldId: reversal.fieldId, entries: released, remarks: p.remarks },
    });
    const finalReversal = await tx.creditReversal.findFirst({ where: { id: reversal.id } });
    const releasedTotal = released.reduce((n, r) => n + r.amountPaise, 0);
    const outcome: PayoutOutcome = {
      cancelled: [],
      receivable: [],
      receivablePaise: 0,
      tdsCreditPaise: 0,
      released,
      headline: `Rejected · ${released.length} entr${released.length === 1 ? 'y' : 'ies'} released · ${formatINR(BigInt(releasedTotal))}`,
      lines: released.map((r) => ({
        kind: 'RELEASED' as const,
        entryId: r.entryId,
        text: `Entry released · ${formatINR(BigInt(r.amountPaise))} · goes into the next bank file again`,
      })),
    };
    return {
      ...finalReversal,
      clawbackShortfall: 0,
      payoutClawbackNote: `Rejected: ${released.length} payout entr${released.length === 1 ? 'y' : 'ies'} released — eligible for the next bank file again.`,
      payoutOutcome: outcome,
    };
  }

  // ── approve ──
  if (allocations.some((a) => a.state !== 'RESERVED')) {
    throw new ConflictException('This reversal’s payout entries are not all reserved any more — reload and retry');
  }
  const reservedTotal = allocations.reduce((s, a) => s + a.amountPaise, 0n);
  if (p.finalApprovedPaise !== reservedTotal || reversal.requestedPaise !== reservedTotal) {
    throw new BadRequestException(
      `A payout reversal is approved in full or rejected — approve ${formatINR(reservedTotal)} or reject it`,
    );
  }

  // P4 lock order: the caller holds credit_batches; entries FOR UPDATE ascending id, then a fresh read.
  const ids = allocations.map((a) => a.payoutEntryId);
  await lockEntries(tx, reversal.clientId, ids);
  const entries = await tx.creditPayoutEntry.findMany({
    where: { id: { in: ids }, clientId: reversal.clientId },
    orderBy: { id: 'asc' },
  });
  const entryById = new Map(entries.map((e) => [e.id, e]));
  for (const a of allocations) {
    const e = entryById.get(a.payoutEntryId);
    if (
      !e ||
      e.batchId !== reversal.batchId ||
      e.outletId !== reversal.outletId ||
      e.fieldId !== reversal.fieldId ||
      e.amountPaise !== a.amountPaise
    ) {
      throw new ConflictException(`Reserved payout entry ${a.payoutEntryId} no longer matches this reversal — contact Gifsy`);
    }
    if (e.status === 'PROCESSING') throw new BadRequestException(SENT_TO_BANK_MESSAGE);
    if (e.status === 'REVERSED') {
      throw new ConflictException(`Reserved payout entry ${a.payoutEntryId} is already REVERSED — contact Gifsy`);
    }
  }

  const claimed = await tx.creditReversal.updateMany({
    where: { id: reversal.id, status: 'PENDING_GIFSY' },
    data: {
      status: p.newStatus,
      approvedPaise: p.finalApprovedPaise,
      approvedBy: p.actorId,
      approvedAt: new Date(),
      remarks: p.remarks,
      // Mirror for the interim selector: if the tenant is ever switched back to LEGACY, these entries stay consumed.
      consumedPayoutEntryIds: ids,
    },
  });
  if (claimed.count === 0) throw new BadRequestException('Reversal already processed');

  // Policy round B: a PAID entry's TDS credit needs the PAN advisory lock the bank download uses — take every one
  // this approval needs up front, sorted (deadlock-free against downloads and other approvals).
  const panKeys = new Set<string>();
  for (const a of allocations) {
    const e = entryById.get(a.payoutEntryId)!;
    if (e.status !== 'PAID') continue;
    for (const k of await receivablePanLockKeys(tx, { id: e.id, clientId: reversal.clientId, outletId: e.outletId, period: e.period })) {
      panKeys.add(k);
    }
  }
  for (const k of [...panKeys].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
  }

  let receivable = 0n;
  let cancelled = 0;
  const notes: string[] = [];
  const outcome: PayoutOutcome = {
    cancelled: [],
    receivable: [],
    receivablePaise: 0,
    tdsCreditPaise: 0,
    released: [],
    lines: [],
  };
  for (const a of allocations) {
    const e = entryById.get(a.payoutEntryId)!;
    let state: PayoutAllocationState;
    let tdsOffset = 0n;
    let receivablePaise = 0n;
    let tdsCreditPaise = 0n;
    if (e.status === 'PAID') {
      // Q11 + owner decision 2 (2026-11-16): cash left — the receivable is the NET cash the retailer received; the
      // withheld TDS stays deposited and becomes a TDS credit on the PAN. The entry stays PAID, unreachable to later
      // reversals.
      const t = await recordReceivableTds(
        tx,
        {
          id: e.id,
          clientId: reversal.clientId,
          outletId: e.outletId,
          amountPaise: e.amountPaise,
          period: e.period,
          tdsSection: e.tdsSection ?? null,
          tdsMethodology: e.tdsMethodology ?? null,
          tdsDeductedPaise: e.tdsDeductedPaise ?? 0n,
        },
        { creditReversalId: reversal.id, actorId: p.actorId, panPosition: deps.panPosition },
      );
      receivablePaise = t.receivablePaise;
      tdsCreditPaise = t.tdsCreditPaise;
      receivable += t.receivablePaise;
      state = 'APPLIED_RECEIVABLE';
      notes.push(
        `entry ${e.id} (PAID ${formatINR(e.amountPaise)}) → receivable ${formatINR(t.receivablePaise)}` +
          (t.tdsCreditPaise > 0n ? ` + TDS credit ${formatINR(t.tdsCreditPaise)} on PAN ${t.panMasked}` : ''),
      );
      outcome.tdsCreditPaise += Number(t.tdsCreditPaise);
      const withheldPaise = e.tdsDeductedPaise ?? 0n;
      outcome.receivable.push({
        entryId: e.id,
        amountPaise: Number(e.amountPaise),
        receivablePaise: Number(t.receivablePaise),
        tdsCreditPaise: Number(t.tdsCreditPaise),
        panMasked: t.panMasked,
        tdsNote: t.note,
        tdsWithheldPaise: Number(withheldPaise),
        coversOtherPayoutsPaise: Number(t.coversOtherPayoutsPaise),
        handBackPaise: Number(t.handBackPaise),
        belowThresholdAfterReversal: t.belowThresholdAfterReversal,
      });
      outcome.lines.push({
        kind: 'RECEIVABLE',
        entryId: e.id,
        text: paidEntryOutcomeText({
          amountPaise: e.amountPaise,
          receivablePaise: t.receivablePaise,
          tdsWithheldPaise: withheldPaise,
          tdsCreditPaise: t.tdsCreditPaise,
          panMasked: t.panMasked,
          methodology: e.tdsMethodology ?? null,
          untrackedWithheldPaise: t.untrackedWithheldPaise,
          coversOtherPayoutsPaise: t.coversOtherPayoutsPaise,
          handBackPaise: t.handBackPaise,
          belowThresholdAfterReversal: t.belowThresholdAfterReversal,
        }),
      });
    } else {
      // PENDING / FAILED: cash never left → cancel. Rows are locked, so the guarded flip must hit exactly one row.
      const withheld = e.tdsDeductedPaise ?? 0n;
      const offsetIt = withheld > 0n && !!e.tdsSection;
      const flip = await tx.creditPayoutEntry.updateMany({
        where: { id: e.id, status: e.status, ...(offsetIt ? { tdsDeductedPaise: withheld } : {}) },
        data: { status: 'REVERSED', downloadId: null, ...(offsetIt ? { tdsDeductedPaise: 0n } : {}) },
      });
      if (flip.count !== 1) {
        throw new ConflictException('A payout entry changed while the reversal was being approved — please retry');
      }
      // TDS offset ONLY for an unpaid entry, at most once (the helper nets the entry's ledger).
      if (offsetIt) {
        tdsOffset = await deps.offsetWithholding({
          id: e.id,
          outletId: e.outletId,
          period: e.period,
          tdsSection: e.tdsSection!,
          tdsDeductedPaise: withheld,
        });
      }
      // Policy round B: TDS credit this unpaid entry had used goes back to the credit (never silent).
      const back = await releaseCreditApplications(tx, [e.id], 'ENTRY_CANCELLED_BY_REVERSAL');
      const backPaise = back.reduce((s, r) => s + r.amountPaise, 0n);
      state = 'APPLIED_CANCELLED';
      cancelled++;
      outcome.lines.push({
        kind: 'CANCELLED',
        entryId: e.id,
        text:
          `Entry cancelled · ${formatINR(e.amountPaise)} · will not be paid` +
          (e.status === 'FAILED' ? ' (the bank payment had failed)' : '') +
          (tdsOffset > 0n ? ` · withheld TDS ${formatINR(tdsOffset)} reversed in the TDS ledger` : '') +
          (backPaise > 0n ? ` · ${formatINR(backPaise)} TDS credit it had used returned to the credit balance` : ''),
      });
      outcome.cancelled.push({
        entryId: e.id,
        amountPaise: Number(e.amountPaise),
        wasStatus: e.status,
        tdsOffsetPaise: Number(tdsOffset),
        tdsNote: !offsetIt
          ? withheld > 0n
            ? `TDS ${formatINR(withheld)} stamped but no TDS section on the entry — not offset; check with Gifsy`
            : 'no TDS withheld'
          : tdsOffset > 0n
            ? `withheld TDS ${formatINR(tdsOffset)} offset in the TDS ledger`
            : `withheld TDS already offset earlier (or no PAN on the deduction) — no second offset`,
      });
      notes.push(
        `entry ${e.id} (was ${e.status}) → REVERSED` + (tdsOffset > 0n ? ` (withheld TDS ${formatINR(tdsOffset)} offset)` : ''),
      );
    }
    const upd = await tx.payoutReversalAllocation.updateMany({
      where: { id: a.id, state: 'RESERVED' },
      data: { state, tdsOffsetPaise: tdsOffset, receivablePaise, tdsCreditPaise },
    });
    if (upd.count !== 1) throw new ConflictException('A payout reservation changed during approval — please retry');
  }

  // L3: written whenever the approval recorded a receivable — also ₹0 (a payout fully withheld as TDS), so the
  // reversal row and the outcome always agree.
  if (outcome.receivable.length > 0) {
    await tx.creditReversal.update({ where: { id: reversal.id }, data: { shortfallPaise: receivable } });
  }
  const payoutClawbackNote = [
    `GLM-1 clawback: ${allocations.length} entries consumed`,
    `(${cancelled} reversed, ${receivable > 0n ? `${formatINR(receivable)} recoverable receivable` : 'no paid receivable'}).`,
    ...notes,
  ].join(' | ');
  outcome.receivablePaise = Number(receivable);
  outcome.headline = approvedHeadline(outcome);
  await auditPayoutReversal(tx, {
    action: 'APPROVE',
    creditReversalId: reversal.id,
    actorId: p.actorId,
    metadata: { step: 'APPLIED', clientId: reversal.clientId, batchId: reversal.batchId, outletId: reversal.outletId, fieldId: reversal.fieldId, remarks: p.remarks, ...outcome },
  });
  const finalReversal = await tx.creditReversal.findFirst({ where: { id: reversal.id } });
  return { ...finalReversal, clawbackShortfall: Number(receivable), payoutClawbackNote, payoutOutcome: outcome };
}

/**
 * Bank download guard (P3, race half). The download reads entries with `reversalAllocations: none RESERVED`, then
 * claims them with a guarded UPDATE that row-locks them. A reservation committed between that read and the claim
 * holds the same rows FOR UPDATE (selectPayoutEntriesV2), so the claim waited for it; this fresh statement (new
 * READ COMMITTED snapshot, after the claim) then sees it. Returns the claimed ids that are reserved — the caller
 * must abort (roll back) when non-empty.
 */
export async function reservedAmong(tx: Prisma.TransactionClient, entryIds: string[]): Promise<string[]> {
  if (entryIds.length === 0) return [];
  const rows = await tx.payoutReversalAllocation.findMany({
    where: { payoutEntryId: { in: entryIds }, state: 'RESERVED' },
    select: { payoutEntryId: true },
  });
  return (rows ?? []).map((r) => r.payoutEntryId);
}

/** An entry a bank download left out because a pending reversal holds it (WP5 — always reported, never silent). */
export interface ReversalHeldEntry {
  entryId: string;
  outletId: string;
  outletName: string;
  fieldName: string;
  amountPaise: number;
  status: string;
  creditReversalId: string;
}

/**
 * The entries in a download's scope (`scopeWhere` = the download's entry filter WITHOUT the hold) that a pending
 * reversal holds. Read through the allocation table so a tenant with no reservations costs one indexed probe.
 */
export async function heldForReversal(
  db: Prisma.TransactionClient,
  scopeWhere: Prisma.CreditPayoutEntryWhereInput,
): Promise<ReversalHeldEntry[]> {
  const rows = await db.payoutReversalAllocation.findMany({
    where: { state: 'RESERVED', payoutEntry: scopeWhere },
    orderBy: { payoutEntryId: 'asc' },
    select: {
      creditReversalId: true,
      payoutEntry: { select: { id: true, outletId: true, outletName: true, fieldName: true, amountPaise: true, status: true } },
    },
  });
  return (rows ?? []).map((r) => ({
    entryId: r.payoutEntry.id,
    outletId: r.payoutEntry.outletId,
    outletName: r.payoutEntry.outletName,
    fieldName: r.payoutEntry.fieldName,
    amountPaise: Number(r.payoutEntry.amountPaise),
    status: String(r.payoutEntry.status),
    creditReversalId: r.creditReversalId,
  }));
}

/** Sentence appended to a download refusal when reversal holds explain (part of) why nothing is payable. */
export function reversalHeldSuffix(held: ReversalHeldEntry[]): string {
  if (held.length === 0) return '';
  const total = held.reduce((n, h) => n + h.amountPaise, 0);
  return ` ${held.length} entr${held.length === 1 ? 'y' : 'ies'} (${formatINR(total)}) ${held.length === 1 ? 'is' : 'are'} held out of bank files because a reversal request is pending — approve or reject it under Pending Reversal Requests.`;
}

/** Audit row for every engine PAYOUT reversal step (reserve / approve / reject) — never log-only. */
async function auditPayoutReversal(
  tx: Prisma.TransactionClient,
  a: {
    action: 'CREATE' | 'APPROVE' | 'REJECT';
    creditReversalId: string;
    actorId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      action: a.action,
      entityType: 'PAYOUT_REVERSAL_ALLOCATION',
      entityId: a.creditReversalId,
      actorId: a.actorId,
      metadata: JSON.parse(
        JSON.stringify(a.metadata, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ) as Prisma.InputJsonValue,
    },
  });
}

// ─── Backfill planner (pure) ────────────────────────────────────────────────────────────────────────────────────

export interface BackfillPayoutReversal {
  id: string;
  clientId: string;
  batchId: string;
  outletId: string;
  fieldId: string;
  status: string; // PENDING_GIFSY | APPROVED | PARTIAL | REJECTED
  awardType: string;
  approvedPaise: bigint | null;
  shortfallPaise: bigint;
  approvedAt: Date | null;
  consumedPayoutEntryIds: unknown;
}

export interface BackfillPayoutEntry {
  id: string;
  clientId: string;
  batchId: string;
  outletId: string;
  fieldId: string;
  amountPaise: bigint;
  status: string;
  createdAt: Date;
}

export interface PlannedPayoutAllocation {
  creditReversalId: string;
  payoutEntryId: string;
  amountPaise: bigint;
  state: 'APPLIED_CANCELLED' | 'APPLIED_RECEIVABLE';
  tdsOffsetPaise: bigint;
  receivablePaise: bigint;
  tdsCreditPaise: bigint;
}

export type PayoutBackfillFlagCode =
  | 'ENTRY_MISSING' // a consumed id does not exist / belongs to another tenant, batch, outlet or field
  | 'ENTRY_NOT_SETTLED' // a consumed entry is PENDING / FAILED / PROCESSING (should be REVERSED or PAID)
  | 'AMOUNT_MISMATCH' // Σ consumed entries ≠ approvedPaise
  | 'DOUBLE_CONSUMPTION' // an entry is already allocated to an earlier reversal (audited bug §8 (1))
  | 'SHORTFALL_MISMATCH' // Σ PAID (receivables) ≠ the recorded shortfallPaise (WARNING: rows still written)
  | 'AMBIGUOUS_LEGACY' // pre-column approval: no unique set of entries explains it
  | 'DERIVED_LEGACY' // pre-column approval: entries derived from history (WARNING: rows written)
  | 'PENDING_LEGACY'; // a pending reversal with no reservation: it will be approved through the interim path (INFO)

export interface PayoutBackfillFlag {
  creditReversalId: string;
  code: PayoutBackfillFlagCode;
  severity: 'BLOCKING' | 'WARNING' | 'INFO';
  detail: string;
}

/**
 * PURE planner for §8 "Backfill existing PAYOUT reversals; ambiguous → flagged" (WP6 calls it per tenant).
 *
 * Inputs: the tenant's PAYOUT CreditReversals, its CreditPayoutEntries for the (batch, outlet, field)s involved,
 * the existing allocation rows (any state — reversals that already have rows are skipped → re-runs are no-ops), and
 * optionally the TDS offset already booked per entry (Σ |negative tdsDeductedThisPaise| ledger rows written by the
 * reversal; default 0 — the money already moved, the column is informational).
 *
 * Output: APPLIED_* rows to INSERT (never RESERVED — a pending legacy reversal keeps the interim path) and flags.
 * Never changes an entry, a reversal or any money; a BLOCKING flag means "no rows for that reversal".
 * Order: approvedAt ascending (first approved wins an entry, as the live rule would have).
 *  - consumedPayoutEntryIds present: every id must be an entry of the same (tenant, batch, outlet, field), REVERSED
 *    (→ APPLIED_CANCELLED) or PAID (→ APPLIED_RECEIVABLE), not allocated already, and Σ = approvedPaise.
 *  - null (approved before that column existed): the entries of the same (batch, outlet, field) created on or before
 *    approvedAt that are REVERSED or PAID and unallocated; ALL of them must sum to approvedPaise, otherwise exactly
 *    ONE subset must (≤ 16 entries) → rows + DERIVED_LEGACY warning; anything else → AMBIGUOUS_LEGACY.
 */
export function planPayoutAllocationBackfill(input: {
  reversals: BackfillPayoutReversal[];
  entries: BackfillPayoutEntry[];
  existingAllocations: { creditReversalId: string; payoutEntryId: string; state: string }[];
  tdsOffsetByEntry?: Map<string, bigint>;
}): { allocations: PlannedPayoutAllocation[]; flags: PayoutBackfillFlag[] } {
  const allocations: PlannedPayoutAllocation[] = [];
  const flags: PayoutBackfillFlag[] = [];
  const entryById = new Map(input.entries.map((e) => [e.id, e]));
  const reversalsWithRows = new Set(input.existingAllocations.map((a) => a.creditReversalId));
  const taken = new Set(
    input.existingAllocations
      .filter((a) => (LIVE_PAYOUT_ALLOCATION_STATES as string[]).includes(a.state))
      .map((a) => a.payoutEntryId),
  );
  const offsetOf = (id: string) => input.tdsOffsetByEntry?.get(id) ?? 0n;
  const flag = (r: BackfillPayoutReversal, code: PayoutBackfillFlagCode, severity: PayoutBackfillFlag['severity'], detail: string) =>
    flags.push({ creditReversalId: r.id, code, severity, detail });
  const sameKey = (r: BackfillPayoutReversal, e: BackfillPayoutEntry) =>
    e.clientId === r.clientId && e.batchId === r.batchId && e.outletId === r.outletId && e.fieldId === r.fieldId;
  const toRows = (r: BackfillPayoutReversal, es: BackfillPayoutEntry[]): PlannedPayoutAllocation[] =>
    es.map((e) => ({
      creditReversalId: r.id,
      payoutEntryId: e.id,
      amountPaise: e.amountPaise,
      state: e.status === 'PAID' ? 'APPLIED_RECEIVABLE' : 'APPLIED_CANCELLED',
      tdsOffsetPaise: e.status === 'PAID' ? 0n : offsetOf(e.id),
      // Approved under the legacy/interim rule: the receivable was the full amount, no TDS credit (round B is V2-only).
      receivablePaise: e.status === 'PAID' ? e.amountPaise : 0n,
      tdsCreditPaise: 0n,
    }));
  const commit = (r: BackfillPayoutReversal, es: BackfillPayoutEntry[]) => {
    const receivable = es.filter((e) => e.status === 'PAID').reduce((s, e) => s + e.amountPaise, 0n);
    if (receivable !== r.shortfallPaise) {
      flag(r, 'SHORTFALL_MISMATCH', 'WARNING', `receivables ${receivable} paise vs recorded shortfall ${r.shortfallPaise} paise`);
    }
    for (const e of es) taken.add(e.id);
    allocations.push(...toRows(r, es));
  };

  const payout = input.reversals
    .filter((r) => r.awardType === 'PAYOUT' && !reversalsWithRows.has(r.id))
    .sort((a, b) => (a.approvedAt?.getTime() ?? Infinity) - (b.approvedAt?.getTime() ?? Infinity) || (a.id < b.id ? -1 : 1));

  for (const r of payout) {
    if (r.status === 'PENDING_GIFSY') {
      flag(r, 'PENDING_LEGACY', 'INFO', 'pending without a reservation — approve/reject through the interim path');
      continue;
    }
    if (r.status !== 'APPROVED' && r.status !== 'PARTIAL') continue;
    const approved = r.approvedPaise ?? 0n;
    if (approved <= 0n) continue;

    if (Array.isArray(r.consumedPayoutEntryIds)) {
      const ids = r.consumedPayoutEntryIds.filter((x): x is string => typeof x === 'string');
      const es: BackfillPayoutEntry[] = [];
      let blocked = false;
      for (const id of ids) {
        const e = entryById.get(id);
        if (!e || !sameKey(r, e)) {
          flag(r, 'ENTRY_MISSING', 'BLOCKING', `consumed entry ${id} not found for this tenant/batch/outlet/field`);
          blocked = true;
        } else if (e.status !== 'REVERSED' && e.status !== 'PAID') {
          flag(r, 'ENTRY_NOT_SETTLED', 'BLOCKING', `consumed entry ${id} is ${e.status}`);
          blocked = true;
        } else if (taken.has(id) || es.some((x) => x.id === id)) {
          flag(r, 'DOUBLE_CONSUMPTION', 'BLOCKING', `entry ${id} is already allocated to another reversal`);
          blocked = true;
        } else es.push(e);
      }
      if (blocked) continue;
      const sum = es.reduce((s, e) => s + e.amountPaise, 0n);
      if (sum !== approved) {
        flag(r, 'AMOUNT_MISMATCH', 'BLOCKING', `consumed entries total ${sum} paise vs approved ${approved} paise`);
        continue;
      }
      commit(r, es);
      continue;
    }

    // Pre-column approval — derive from history.
    const cutoff = r.approvedAt?.getTime() ?? -Infinity;
    const pool = input.entries
      .filter(
        (e) =>
          sameKey(r, e) &&
          (e.status === 'REVERSED' || e.status === 'PAID') &&
          !taken.has(e.id) &&
          e.createdAt.getTime() <= cutoff,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
    const total = pool.reduce((s, e) => s + e.amountPaise, 0n);
    if (pool.length > 0 && total === approved) {
      flag(r, 'DERIVED_LEGACY', 'WARNING', `all ${pool.length} settled entries up to approval match ${approved} paise`);
      commit(r, pool);
      continue;
    }
    let match: BackfillPayoutEntry[] | null = null;
    let matches = 0;
    if (pool.length > 0 && pool.length <= 16) {
      for (let mask = 1; mask < 1 << pool.length && matches < 2; mask++) {
        let s = 0n;
        for (let i = 0; i < pool.length; i++) if (mask & (1 << i)) s += pool[i].amountPaise;
        if (s === approved) {
          matches++;
          match = pool.filter((_e, i) => mask & (1 << i));
        }
      }
    }
    if (matches === 1 && match) {
      flag(r, 'DERIVED_LEGACY', 'WARNING', `unique subset of ${match.length} settled entries matches ${approved} paise`);
      commit(r, match);
    } else {
      flag(
        r,
        'AMBIGUOUS_LEGACY',
        'BLOCKING',
        `${pool.length} settled entries (${total} paise) — ${matches === 0 ? 'no' : 'more than one'} subset matches ${approved} paise`,
      );
    }
  }
  return { allocations, flags };
}
