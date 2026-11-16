/**
 * Wallet Reversal Engine — WP6 VERIFY checks V0–V9 (PURE, read-only evaluation of a loaded tenant snapshot).
 *
 * Mirrors the verification queries of WALLET-REVERSAL-ENGINE-DESIGN.md §9 one-for-one (the SQL text is kept below in
 * VERIFY_SQL for manual psql runs); the verify job loads each tenant's rows and evaluates them here so every check is
 * unit-tested on fixtures. Each check returns PASS / FAIL (or INFO) per tenant with the offending ids.
 */
import { createHash } from 'node:crypto';
import { planPayoutAllocationBackfill } from '../../credits/payout-reversal-v2';
import type { PayoutBackfillInput } from './backfill-runner';

export interface VWallet {
  id: string;
  redeemablePoints: number;
  debtPoints: number;
  movementSeq: number;
  earnedPoints: number;
  lifetimeEarned: number;
  redeemedPoints: number;
  expiredPoints: number;
  lifetimeRedeemed: number;
  lifetimeExpired: number;
  lockedPoints: number;
  /** wallets.backfillStatus (policy round A): 'BLOCKED' wallets are excluded from V1/V2/V3/V7 and listed by V10 */
  backfillStatus?: string | null;
}

export interface VTx {
  id: string;
  walletId: string;
  seq: number | null;
  pointsDelta: number | null;
  balanceAfter: number;
  transactionType: string;
  referenceType: string | null;
  referenceId: string | null;
  points: number;
}

export interface VPosition {
  id: string;
  walletId: string;
  creditTxId: string;
  amount: number;
  offsetPoints: number;
  reversedPoints: number;
  attribution: string;
}

export interface VAllocation {
  positionId: string;
  creditReversalId: string;
  requested: number;
  recovered?: number;
  /** Q4: historical clawback beyond holdings, booked as debt */
  owed?: number;
}

export interface VPayoutAllocation {
  payoutEntryId: string;
  creditReversalId: string;
  state: string;
}

export interface VerifySnapshot {
  clientId: string;
  wallets: VWallet[];
  txs: VTx[];
  positions: VPosition[];
  allocations: VAllocation[];
  payoutAllocations: VPayoutAllocation[];
  /** WP5 payout planner input — V9b re-runs the planner read-only (absent → V9b skipped) */
  payoutBackfill?: PayoutBackfillInput;
}

/** V0 — tenant totals + a digest over EVERY wallet's balance and counters (equal digest ⇔ no wallet changed). */
export interface V0Snapshot {
  clientId: string;
  wallets: number;
  redeemablePoints: number;
  earnedPoints: number;
  lifetimeEarned: number;
  redeemedPoints: number;
  expiredPoints: number;
  lifetimeRedeemed: number;
  lifetimeExpired: number;
  lockedPoints: number;
  /** sha256 over sorted `id:redeemable:earned:lifetimeEarned:redeemed:expired:lifetimeRedeemed:lifetimeExpired:locked` */
  balanceDigest: string;
}

export function computeV0(clientId: string, wallets: VWallet[]): V0Snapshot {
  const s: V0Snapshot = {
    clientId,
    wallets: wallets.length,
    redeemablePoints: 0,
    earnedPoints: 0,
    lifetimeEarned: 0,
    redeemedPoints: 0,
    expiredPoints: 0,
    lifetimeRedeemed: 0,
    lifetimeExpired: 0,
    lockedPoints: 0,
    balanceDigest: '',
  };
  const lines: string[] = [];
  for (const w of wallets) {
    s.redeemablePoints += w.redeemablePoints;
    s.earnedPoints += w.earnedPoints;
    s.lifetimeEarned += w.lifetimeEarned;
    s.redeemedPoints += w.redeemedPoints;
    s.expiredPoints += w.expiredPoints;
    s.lifetimeRedeemed += w.lifetimeRedeemed;
    s.lifetimeExpired += w.lifetimeExpired;
    s.lockedPoints += w.lockedPoints;
    lines.push(
      [w.id, w.redeemablePoints, w.earnedPoints, w.lifetimeEarned, w.redeemedPoints, w.expiredPoints, w.lifetimeRedeemed, w.lifetimeExpired, w.lockedPoints].join(':'),
    );
  }
  lines.sort();
  s.balanceDigest = createHash('sha256').update(lines.join('\n')).digest('hex');
  return s;
}

/** Field-by-field V0 difference (empty = identical). */
export function diffV0(before: V0Snapshot, after: V0Snapshot): string[] {
  const out: string[] = [];
  for (const k of Object.keys(before) as (keyof V0Snapshot)[]) {
    if (before[k] !== after[k]) out.push(`${k}: ${String(before[k])} → ${String(after[k])}`);
  }
  return out;
}

/** WARN = passes, but something needs GIFSY's attention (owner rule: never silent) — printed, counted, exit 0. */
export type CheckStatus = 'PASS' | 'FAIL' | 'INFO' | 'SKIP' | 'WARN';

export interface CheckResult {
  check: string;
  clientId: string;
  status: CheckStatus;
  detail: string;
  /** offending ids (capped) */
  ids: string[];
}

export interface VerifyOptions {
  /** V0 baseline captured BEFORE the backfill (the backfill job prints it); absent → V0 reported as INFO */
  v0Baseline?: V0Snapshot;
  /** V5 applies: tenants whose wallets must never carry debt (default: deoleo) */
  neverNegativeTenant: boolean;
  /** V6b: expected multiset of negative balances for this tenant (e.g. Bajaj prod's 8); absent → not checked */
  expectedNegativeBalances?: number[];
}

const CAP = 20;

function result(check: string, clientId: string, bad: string[], passDetail: string, failDetail: string): CheckResult {
  return {
    check,
    clientId,
    status: bad.length === 0 ? 'PASS' : 'FAIL',
    detail: bad.length === 0 ? passDetail : `${bad.length} ${failDetail}`,
    ids: bad.slice(0, CAP),
  };
}

export function isReversibleCreditTx(t: Pick<VTx, 'transactionType' | 'referenceType' | 'referenceId' | 'points'>): boolean {
  return t.transactionType === 'CREDIT_POINTS_EARNED' && t.referenceType === 'CREDIT_BATCH' && !!t.referenceId && t.points > 0;
}

export function runVerifyChecks(snap: VerifySnapshot, opts: VerifyOptions): CheckResult[] {
  const c = snap.clientId;
  const out: CheckResult[] = [];
  // Policy round A (Q1/Q2): a wallet the backfill BLOCKED (still un-sequenced) is not backfilled BY DESIGN — it keeps
  // today's rules and is listed by V10 with its reason; the sequencing checks V1/V2/V3/V7 run on every other wallet.
  const blocked = new Set(snap.wallets.filter((w) => w.backfillStatus === 'BLOCKED' && w.movementSeq === 0).map((w) => w.id));
  const txByWallet = new Map<string, VTx[]>();
  for (const t of snap.txs) {
    const g = txByWallet.get(t.walletId);
    if (g) g.push(t);
    else txByWallet.set(t.walletId, [t]);
  }
  for (const g of txByWallet.values()) g.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));

  // V0 — snapshot before AND after must be identical.
  const v0 = computeV0(c, snap.wallets);
  if (opts.v0Baseline) {
    const d = diffV0(opts.v0Baseline, v0);
    out.push({ check: 'V0 balances/counters unchanged', clientId: c, status: d.length ? 'FAIL' : 'PASS', detail: d.length ? d.join('; ') : `identical (${v0.wallets} wallets, digest ${v0.balanceDigest.slice(0, 12)}…)`, ids: [] });
  } else {
    out.push({ check: 'V0 balances/counters unchanged', clientId: c, status: 'INFO', detail: `no baseline given — snapshot ${JSON.stringify(v0)}`, ids: [] });
  }

  // V1 — seq contiguity: max(seq) = count(rows) = movementSeq; no NULL seq.
  const v1: string[] = [];
  for (const w of snap.wallets) {
    if (blocked.has(w.id)) continue;
    const ts = txByWallet.get(w.id) ?? [];
    const seqs = ts.map((t) => t.seq);
    const nulls = seqs.filter((s) => s === null).length;
    const max = ts.reduce((m, t) => Math.max(m, t.seq ?? 0), 0);
    const distinct = new Set(seqs.filter((s) => s !== null)).size;
    if (nulls > 0 || max !== ts.length || max !== w.movementSeq || distinct !== ts.length) v1.push(w.id);
  }
  out.push(result('V1 seq contiguity', c, v1, 'every wallet: seq 1..n contiguous and = movementSeq', 'wallet(s) with gaps / NULL seq / movementSeq mismatch'));

  // V2 — chain integrity: balanceAfter = previous balanceAfter (0 for the first) + pointsDelta.
  const v2: string[] = [];
  for (const [walletId, ts] of txByWallet) {
    if (blocked.has(walletId)) continue;
    let prev = 0;
    for (const t of ts) {
      if (t.pointsDelta === null || t.balanceAfter !== prev + t.pointsDelta) v2.push(t.id);
      prev = t.balanceAfter;
    }
  }
  out.push(result('V2 chain integrity', c, v2, 'balanceAfter = prev + pointsDelta on every row', 'row(s) break the chain'));

  // V3 — last row's balanceAfter = wallet balance (wallets with history).
  const v3: string[] = [];
  for (const w of snap.wallets) {
    if (blocked.has(w.id)) continue;
    const ts = txByWallet.get(w.id) ?? [];
    const last = ts[ts.length - 1];
    if (last ? last.balanceAfter !== w.redeemablePoints : w.redeemablePoints !== 0) v3.push(w.id);
  }
  out.push(result('V3 last row = wallet balance', c, v3, 'every wallet', 'wallet(s) whose last balanceAfter ≠ redeemablePoints'));

  // V4 — D ≥ 0 and H = B + D ≥ 0.
  const v4 = snap.wallets.filter((w) => w.debtPoints < 0 || w.redeemablePoints + w.debtPoints < 0).map((w) => w.id);
  out.push(result('V4 holdings non-negative', c, v4, 'D ≥ 0 and B + D ≥ 0 everywhere', 'wallet(s) with D < 0 or H < 0'));

  // V5 — never-negative tenant (Deoleo): D = 0, every O = 0, min balanceAfter ≥ 0.
  if (opts.neverNegativeTenant) {
    const bad: string[] = [];
    for (const w of snap.wallets) if (w.debtPoints !== 0 || w.redeemablePoints < 0) bad.push(w.id);
    for (const p of snap.positions) if (p.offsetPoints !== 0) bad.push(p.id);
    for (const t of snap.txs) if (t.balanceAfter < 0) bad.push(t.id);
    out.push(result('V5 never-negative tenant: D = 0, O = 0, min balance ≥ 0', c, bad, `${snap.wallets.length} wallets, ${snap.positions.length} positions all zero-debt`, 'wallet/position/row id(s) violate I5'));
  } else {
    out.push({ check: 'V5 never-negative tenant: D = 0, O = 0, min balance ≥ 0', clientId: c, status: 'SKIP', detail: 'tenant not configured as never-negative', ids: [] });
  }

  // V6 — negative wallets are covered by debt (H ≥ 0), + expected set (Bajaj prod: 8) when configured.
  const negatives = snap.wallets.filter((w) => w.redeemablePoints < 0);
  const uncovered = negatives.filter((w) => w.redeemablePoints + w.debtPoints < 0).map((w) => w.id);
  out.push({
    ...result('V6 negative wallets covered by debt', c, uncovered, '', 'negative wallet(s) with B + D < 0'),
    detail: uncovered.length
      ? `${uncovered.length} negative wallet(s) with B + D < 0`
      : `${negatives.length} negative wallet(s), Σ balance ${negatives.reduce((s, w) => s + w.redeemablePoints, 0)}, Σ debt ${negatives.reduce((s, w) => s + w.debtPoints, 0)}: ${negatives
          .map((w) => `${w.id} B ${w.redeemablePoints} D ${w.debtPoints}`)
          .join('; ')}`,
  });
  if (opts.expectedNegativeBalances) {
    const want = [...opts.expectedNegativeBalances].sort((a, b) => a - b);
    const got = negatives.map((w) => w.redeemablePoints).sort((a, b) => a - b);
    const same = want.length === got.length && want.every((v, i) => v === got[i]);
    out.push({
      check: 'V6b expected negative balances unchanged',
      clientId: c,
      status: same ? 'PASS' : 'FAIL',
      detail: `expected [${want.join(', ')}] (Σ ${want.reduce((s, v) => s + v, 0)}), found [${got.join(', ')}] (Σ ${got.reduce((s, v) => s + v, 0)})`,
      ids: negatives.map((w) => w.id).slice(0, CAP),
    });
  }

  // V7 — position coverage: every credit-batch POINTS credit has exactly one position on its own wallet; attribution counts.
  const posByCredit = new Map(snap.positions.map((p) => [p.creditTxId, p]));
  const txById = new Map(snap.txs.map((t) => [t.id, t]));
  const v7: string[] = [];
  for (const t of snap.txs) {
    if (!isReversibleCreditTx(t) || blocked.has(t.walletId)) continue;
    const p = posByCredit.get(t.id);
    if (!p || p.walletId !== t.walletId || p.amount !== t.points) v7.push(t.id);
  }
  for (const p of snap.positions) {
    const t = txById.get(p.creditTxId);
    if (!t || !isReversibleCreditTx(t)) v7.push(p.id);
  }
  const attr: Record<string, number> = {};
  for (const p of snap.positions) attr[p.attribution] = (attr[p.attribution] ?? 0) + 1;
  out.push({
    ...result('V7 position coverage', c, v7, '', 'credit(s)/position(s) without a matching counterpart (or wrong wallet/amount)'),
    detail: v7.length ? `${v7.length} credit(s)/position(s) without a matching counterpart (or wrong wallet/amount); attribution ${JSON.stringify(attr)}` : `every credit-batch credit has its position; attribution ${JSON.stringify(attr)}`,
  });

  // V8 — reversedPoints = Σ allocations.requested ≤ amount.
  const allocSum = new Map<string, number>();
  for (const a of snap.allocations) allocSum.set(a.positionId, (allocSum.get(a.positionId) ?? 0) + a.requested);
  const v8 = snap.positions.filter((p) => p.reversedPoints !== (allocSum.get(p.id) ?? 0) || p.reversedPoints > p.amount).map((p) => p.id);
  const owed = snap.allocations.reduce((s, a) => s + (a.owed ?? 0), 0);
  const recovered = snap.allocations.reduce((s, a) => s + (a.recovered ?? 0), 0);
  out.push(
    result(
      'V8 reversedPoints = Σ allocations ≤ amount',
      c,
      v8,
      `${snap.allocations.length} allocation(s) reconcile; recovered ${recovered}, owed ${owed}${owed > 0 ? ' (historical clawbacks beyond holdings, booked as debt — not recovered)' : ''}`,
      'position(s) mismatch',
    ),
  );

  // V9 — no payout entry in two live reversals.
  const live = new Set(['RESERVED', 'APPLIED_CANCELLED', 'APPLIED_RECEIVABLE']);
  const cnt = new Map<string, number>();
  for (const a of snap.payoutAllocations) if (live.has(a.state)) cnt.set(a.payoutEntryId, (cnt.get(a.payoutEntryId) ?? 0) + 1);
  const v9 = [...cnt].filter(([, n]) => n > 1).map(([id]) => id);
  out.push(result('V9 payout entry in ≤ 1 live reversal', c, v9, `${snap.payoutAllocations.length} payout allocation(s)`, 'payout entr(y/ies) in two live reversals'));

  // V9b — the WP5 payout backfill planner, re-run read-only: an approved PAYOUT reversal it would STILL give rows (the
  // backfill was not applied for it — e.g. approved under LEGACY since) or that it flags (ambiguous / double
  // consumption / …) needs Gifsy. WARN, never silent.
  if (snap.payoutBackfill) {
    const pp = planPayoutAllocationBackfill(snap.payoutBackfill);
    const pendingRows = [...new Set(pp.allocations.map((a) => a.creditReversalId))];
    const flagged = pp.flags.filter((f) => f.severity !== 'INFO');
    const bad = [...pendingRows, ...flagged.map((f) => f.creditReversalId)];
    out.push({
      check: 'V9b payout reversal allocations backfilled',
      clientId: c,
      status: bad.length ? 'WARN' : 'PASS',
      detail: bad.length
        ? `${pendingRows.length} approved PAYOUT reversal(s) still without allocation rows (re-run the backfill); ${flagged.length} flag(s): ${flagged
            .map((f) => `${f.creditReversalId} ${f.severity} ${f.code} — ${f.detail}`)
            .join('; ')}`
        : `${snap.payoutBackfill.reversals.length} PAYOUT reversal(s): every approved one has its allocation rows`,
      ids: [...new Set(bad)].slice(0, CAP),
    });
  } else {
    out.push({ check: 'V9b payout reversal allocations backfilled', clientId: c, status: 'SKIP', detail: 'payout input not loaded', ids: [] });
  }

  // V10 — wallets needing Gifsy attention (Q1/Q2): BLOCKED by the backfill, with the reason. They keep today's rules;
  // POINTS reversals on them are refused until Gifsy fixes the history and re-runs the backfill.
  const blockedRows = snap.wallets.filter((w) => blocked.has(w.id));
  out.push({
    check: 'V10 wallets needing Gifsy attention',
    clientId: c,
    status: blockedRows.length ? 'WARN' : 'PASS',
    detail: blockedRows.length
      ? `${blockedRows.length} wallet(s) BLOCKED by the backfill — earn/redeem on today's rules, points reversals refused (reasons: GET /v1/admin/credits/reversal-engine/attention or the backfill ATTENTION block)`
      : 'none',
    ids: blockedRows.map((w) => w.id).slice(0, CAP),
  });

  return out;
}

/** The §9 queries, verbatim in spirit and tenant-scoped, for a manual psql cross-check (read-only; guard first). */
export const VERIFY_SQL = `
-- Guard every session first:  SELECT current_database();
-- V0 snapshot before AND after backfill (must be identical)
SELECT cp."clientId", count(*), sum(w."redeemablePoints"), sum(w."earnedPoints"), sum(w."lifetimeEarned"),
       sum(w."redeemedPoints"), sum(w."expiredPoints")
FROM wallets w JOIN channel_partners cp ON cp.id = w."partnerId" GROUP BY 1 ORDER BY 1;
-- V1 seq contiguity (expect 0 rows)
SELECT w.id FROM wallets w LEFT JOIN wallet_transactions t ON t."walletId" = w.id
GROUP BY w.id, w."movementSeq" HAVING coalesce(max(t.seq),0) <> count(t.id) OR coalesce(max(t.seq),0) <> w."movementSeq"
   OR count(t.id) <> count(t.seq);
-- V2 chain integrity (expect 0 rows)
SELECT * FROM (SELECT id, "walletId", seq, "pointsDelta", "balanceAfter",
  lag("balanceAfter") OVER (PARTITION BY "walletId" ORDER BY seq) AS prev FROM wallet_transactions) x
WHERE "balanceAfter" <> coalesce(prev, 0) + "pointsDelta" OR "pointsDelta" IS NULL;
-- V3 last row == wallet balance (expect 0 rows)
SELECT w.id FROM wallets w JOIN LATERAL (SELECT "balanceAfter" FROM wallet_transactions t
  WHERE t."walletId" = w.id ORDER BY seq DESC LIMIT 1) l ON true WHERE l."balanceAfter" <> w."redeemablePoints";
-- V4 holdings non-negative (expect 0 rows)
SELECT id FROM wallets WHERE "debtPoints" < 0 OR "redeemablePoints" + "debtPoints" < 0;
-- V5 Deoleo zero debt / zero offsets / min balanceAfter >= 0 (expect 0 rows each)
SELECT w.id FROM wallets w JOIN channel_partners cp ON cp.id = w."partnerId" WHERE cp."clientId" = 'deoleo' AND (w."debtPoints" <> 0 OR w."redeemablePoints" < 0);
SELECT p.id FROM wallet_credit_positions p JOIN wallets w ON w.id = p."walletId" JOIN channel_partners cp ON cp.id = w."partnerId" WHERE cp."clientId" = 'deoleo' AND p."offsetPoints" <> 0;
SELECT t.id FROM wallet_transactions t JOIN wallets w ON w.id = t."walletId" JOIN channel_partners cp ON cp.id = w."partnerId" WHERE cp."clientId" = 'deoleo' AND t."balanceAfter" < 0;
-- V6 negative wallets (Bajaj prod expect 8: -840,-612,-520,-360,-360,-297,-280,-280) covered by debt
SELECT w.id, w."redeemablePoints", w."debtPoints", w."redeemablePoints" + w."debtPoints" AS holdings FROM wallets w WHERE w."redeemablePoints" < 0;
-- V7 position coverage (expect 0 rows) + attribution counts
SELECT t.id FROM wallet_transactions t LEFT JOIN wallet_credit_positions p ON p."creditTxId" = t.id
WHERE t."transactionType" = 'CREDIT_POINTS_EARNED' AND t."referenceType" = 'CREDIT_BATCH' AND t.points > 0 AND p.id IS NULL;
SELECT attribution, count(*) FROM wallet_credit_positions GROUP BY 1;
-- V8 reversedPoints == Σ allocations <= amount (expect 0 rows)
SELECT p.id FROM wallet_credit_positions p LEFT JOIN credit_reversal_allocations a ON a."positionId" = p.id
GROUP BY p.id, p."reversedPoints", p.amount HAVING p."reversedPoints" <> coalesce(sum(a.requested),0) OR p."reversedPoints" > p.amount;
-- V9 no payout entry in two live reversals (expect 0 rows)
SELECT "payoutEntryId" FROM payout_reversal_allocations WHERE state IN ('RESERVED','APPLIED_CANCELLED','APPLIED_RECEIVABLE')
GROUP BY 1 HAVING count(*) > 1;
`;
