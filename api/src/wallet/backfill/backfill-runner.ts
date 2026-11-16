/**
 * Wallet Reversal Engine — WP6 backfill RUNNER (orchestration over a storage port; no Prisma here).
 *
 * DRY_RUN is the default: per tenant it loads every wallet's history, plans it (backfill-plan.ts → WP0 replay) and prints
 * the summary, the debt wallets, every anomaly, every BLOCKED wallet with its reason and the PAYOUT reversal backfill
 * plan (payout-reversal-v2.ts planPayoutAllocationBackfill) — and writes NOTHING. APPLY needs BOTH `BACKFILL_APPLY=true`
 * and `BACKFILL_CONFIRM="APPLY <db>"`, and every run is refused unless `current_database()` == EXPECTED_DB.
 *
 * APPLY, per tenant (policy round A, owner 2026-11-16):
 *  1. Q5 — turns the tenant's "POINTS reversal approvals paused" switch ON (unless already on) and DRAINS in-flight
 *     reversal transactions (exclusive advisory lock), so no clawback commits during the run; turned OFF again at the
 *     end (also after a crash) unless KEEP_POINTS_REVERSALS_PAUSED=true or it was already on before the run.
 *  2. V0 snapshot → for each PLANNED wallet (ascending id) ONE transaction that takes the job advisory lock + the wallet
 *     row lock, re-reads the wallet's history, re-plans it with the same tenant adjustments and writes only if the fresh
 *     plan is IDENTICAL to the planned one (else CHANGED → skipped, picked up by the next run); the wallet is marked DONE.
 *  3. Q2 — BLOCKED wallets never stop the clean ones: every clean wallet is processed, each BLOCKED wallet is marked
 *     (wallets.backfillStatus = BLOCKED + reason — it keeps today's rules, only reversals on it are refused) and listed
 *     with its reason in the report.
 *  4. PAYOUT reversal allocations (WP5 planner): BLOCKING flags → no rows for that reversal (listed); the rest inserted
 *     under the batch row locks after an identical re-plan.
 *  5. V0 — earn/redeem traffic is NOT paused (only POINTS reversal approvals are), so tenant totals may move during the
 *     run. Two layers (verify-checks.ts V0 block): (a) PER WALLET, inside step 2's transaction, the wallet's figures +
 *     movement-row digest + lot digest are read under its lock right before and right after the backfill's writes — any
 *     difference is a backfill defect: that transaction rolls back (WalletGuardError), the run stops writing (no
 *     further wallet, tenant or payout step) and exits 4 naming the wallet; (b) TENANT reconciliation: a per-wallet
 *     snapshot before and after the run; each wallet's balance change must equal the net of the movement rows committed
 *     in between and figures may only move with new rows → printed as "live activity during the run: +X earned / −Y
 *     redeemed — explained"; anything unexplained → exit 4 with the amount and the wallets.
 * A wallet is done once its movementSeq > 0 and every row carries a seq, so re-running is safe and resumes where a
 * crashed run stopped. A re-run only does work for wallets that are not sequenced yet (new wallets with legacy
 * history, previously BLOCKED ones) — sequenced wallets are loaded as counts only (cheap; see §9.1 runbook).
 */
import {
  BfTenantContext,
  BfWalletHistory,
  planIdentity,
  planTenant,
  planWallet,
  summarizeTenant,
  TenantAdjustments,
  TenantPlan,
  TenantSummary,
  WalletPlan,
} from './backfill-plan';
import { computeV0, diffV0, liveActivityLine, reconcileV0Wallets, V0Reconciliation, V0Snapshot, V0WalletRow, WalletGuardError } from './verify-checks';
import {
  BackfillPayoutEntry,
  BackfillPayoutReversal,
  PayoutBackfillFlag,
  planPayoutAllocationBackfill,
  PlannedPayoutAllocation,
} from '../../credits/payout-reversal-v2';

export type ApplyOutcome = 'APPLIED' | 'ALREADY_DONE' | 'CHANGED';

/** What the WP5 payout planner needs for one tenant. */
export interface PayoutBackfillInput {
  reversals: BackfillPayoutReversal[];
  entries: BackfillPayoutEntry[];
  existingAllocations: { creditReversalId: string; payoutEntryId: string; state: string }[];
}

export interface PausePriorState {
  paused: boolean;
  since: string | null;
}

export interface BackfillStore {
  currentDatabase(): Promise<string>;
  /** tenants that own at least one wallet, sorted */
  listTenants(): Promise<string[]>;
  loadTenantContext(clientId: string): Promise<BfTenantContext>;
  /** every wallet of the tenant with its history (sequenced wallets may come as counts only — sequencedSummary) */
  loadTenantHistories(clientId: string): Promise<BfWalletHistory[]>;
  /** V0 per-wallet rows of the tenant (figures + movement-row count / Σ in / Σ out) from ONE consistent read. */
  snapshotV0Wallets(clientId: string): Promise<V0WalletRow[]>;
  /**
   * In ONE transaction: advisory lock, `SELECT … FROM wallets WHERE id = $1 FOR UPDATE`, re-read the wallet history,
   * then `decide(fresh)`: null → CHANGED (no writes); a plan → write it with guarded statements (every guard must match
   * exactly one row or the transaction rolls back) and mark the wallet DONE. movementSeq > 0 after the lock → ALREADY_DONE.
   * V0 per-wallet guard: the WalletGuardState is read under the lock right before the writes and right after them; any
   * difference (diffWalletGuard) throws WalletGuardError → the transaction rolls back.
   */
  applyWalletPlan(walletId: string, clientId: string, decide: (fresh: BfWalletHistory) => WalletPlan | null): Promise<ApplyOutcome>;
  /** Q1/Q2: persist BLOCKED + reason on wallets still un-sequenced (movementSeq = 0); returns how many were marked. */
  markWalletsBlocked(clientId: string, items: { walletId: string; reason: string }[]): Promise<number>;
  /** Q5: read / set the tenant's POINTS-reversal pause switch. */
  getPointsReversalPause(clientId: string): Promise<PausePriorState>;
  setPointsReversalPause(clientId: string, paused: boolean, reason: string): Promise<void>;
  /** Q5: wait until every in-flight POINTS reversal transaction of the tenant has finished (exclusive advisory lock). */
  drainPointsReversals(clientId: string): Promise<void>;
  /** WP5 payout planner input (read-only, no locks). */
  loadPayoutBackfillInput(clientId: string): Promise<PayoutBackfillInput>;
  /**
   * In ONE transaction: advisory lock + the involved credit_batches rows FOR UPDATE (ascending id), re-read the input,
   * `decide(fresh)`: null → 'CHANGED' (no writes); rows → insert them. Returns the outcome + rows inserted.
   */
  applyPayoutPlan(
    clientId: string,
    decide: (fresh: PayoutBackfillInput) => PlannedPayoutAllocation[] | null,
  ): Promise<{ outcome: 'APPLIED' | 'CHANGED'; inserted: number }>;
}

export interface BackfillConfig {
  expectedDb: string | undefined;
  apply: boolean;
  confirm: string | undefined;
  tenants?: string[];
  /** only wallets with id > this (ascending scan) */
  resumeAfterWallet?: string;
  /** max wallets to apply in this run (per tenant) — for a staged first run */
  maxWallets?: number;
  /** leave the POINTS reversal pause ON after APPLY (e.g. the tenant is flipped to V2 right after) */
  keepPaused?: boolean;
}

export interface PayoutRunReport {
  planned: number;
  inserted: number;
  outcome: 'NONE' | 'APPLIED' | 'CHANGED' | 'DRY_RUN';
  flags: PayoutBackfillFlag[];
}

export interface TenantRunReport {
  clientId: string;
  summary: TenantSummary;
  applied: number;
  alreadyDone: number;
  changed: number;
  skippedBlocked: number;
  /** BLOCKED wallets persisted as such (APPLY) */
  markedBlocked: number;
  lastWalletId: string | null;
  v0Before?: V0Snapshot;
  v0After?: V0Snapshot;
  /** raw tenant-total difference (live traffic included) — informational; the verdict is v0Reconciliation + walletGuardFailures */
  v0Diff?: string[];
  /** tenant reconciliation: every change explained by movement rows committed during the run? */
  v0Reconciliation?: V0Reconciliation;
  /** wallets whose figures / movement rows / lots the BACKFILL's own writes changed (rolled back) — exit 4 */
  walletGuardFailures: { walletId: string; diff: string[] }[];
  refused?: string;
  payout?: PayoutRunReport;
  pause?: { pausedByRun: boolean; leftPaused: boolean; priorSince: string | null };
  /** Q2 / owner rule: everything that needs GIFSY's attention after this run */
  attention: {
    blockedWallets: { walletId: string; reason: string }[];
    payoutReversals: PayoutBackfillFlag[];
    owedClawbacks: { owed: number; recovered: number; count: number };
  };
}

export interface BackfillReport {
  database: string | null;
  mode: 'DRY_RUN' | 'APPLY';
  tenants: TenantRunReport[];
  exitCode: number;
  error?: string;
}

const PAUSE_REASON = 'wallet backfill APPLY in progress';

/**
 * Exit codes: 0 ok (BLOCKED wallets do NOT fail the run — Q2 — they are listed under ATTENTION) · 2 guard refused ·
 * 3 wallets / payout plan CHANGED mid-run (re-run) · 4 V0 ALARM: a backfill write changed a wallet's balance / counters /
 * movement amounts / lots (rolled back; the run stops writing), or a tenant balance change no movement row explains.
 * Live earn/redeem traffic during the run is NOT an alarm — it is reconciled and printed as "live activity … explained".
 */
export async function runBackfill(store: BackfillStore, cfg: BackfillConfig, log: (line: string) => void): Promise<BackfillReport> {
  const mode = cfg.apply ? 'APPLY' : 'DRY_RUN';
  const report: BackfillReport = { database: null, mode, tenants: [], exitCode: 0 };
  if (!cfg.expectedDb) {
    report.exitCode = 2;
    report.error = 'EXPECTED_DB is not set — name the database this run targets';
    log(`REFUSED: ${report.error}`);
    return report;
  }
  const db = await store.currentDatabase();
  report.database = db;
  if (db !== cfg.expectedDb) {
    report.exitCode = 2;
    report.error = `connected to "${db}" but EXPECTED_DB="${cfg.expectedDb}"`;
    log(`REFUSED: ${report.error}`);
    return report;
  }
  if (cfg.apply && cfg.confirm !== `APPLY ${db}`) {
    report.exitCode = 2;
    report.error = `APPLY requires BACKFILL_CONFIRM="APPLY ${db}"`;
    log(`REFUSED: ${report.error}`);
    return report;
  }
  log(`wallet-reversal backfill — ${mode} on ${db}`);

  const tenants = cfg.tenants && cfg.tenants.length ? cfg.tenants : await store.listTenants();
  for (const clientId of tenants) {
    // Q5: pause POINTS reversal create/approve for the APPLY window, then drain the in-flight ones.
    let pausedByRun = false;
    let priorSince: string | null = null;
    if (cfg.apply) {
      const prior = await store.getPointsReversalPause(clientId);
      priorSince = prior.paused ? prior.since : null;
      if (!prior.paused) {
        await store.setPointsReversalPause(clientId, true, PAUSE_REASON);
        pausedByRun = true;
        log(`[${clientId}] POINTS reversal approvals PAUSED for the APPLY window`);
      } else {
        log(`[${clientId}] POINTS reversal approvals were already paused (since ${prior.since ?? '?'}) — left as they are`);
      }
      await store.drainPointsReversals(clientId);
    }
    let halt = false;
    try {
      halt = await runTenant(store, cfg, clientId, report, log);
    } finally {
      if (pausedByRun && !cfg.keepPaused) {
        await store.setPointsReversalPause(clientId, false, 'wallet backfill APPLY finished');
        log(`[${clientId}] POINTS reversal approvals RESUMED`);
      } else if (pausedByRun) {
        log(`[${clientId}] ⚠ POINTS reversal approvals LEFT PAUSED (KEEP_POINTS_REVERSALS_PAUSED=true) — lift it from the admin screen or re-run without it`);
      }
      const tr = report.tenants.find((t) => t.clientId === clientId);
      if (tr) tr.pause = { pausedByRun, leftPaused: pausedByRun && !!cfg.keepPaused, priorSince };
    }
    if (halt) {
      const rest = tenants.slice(tenants.indexOf(clientId) + 1);
      log(`‼ STOPPED: a backfill write changed a wallet (see above) — nothing further written${rest.length ? `; tenants not processed: ${rest.join(', ')}` : ''}`);
      break;
    }
  }
  for (const t of report.tenants) printAttention(t, log);
  log(`done — exit ${report.exitCode}`);
  return report;
}

async function runTenant(
  store: BackfillStore,
  cfg: BackfillConfig,
  clientId: string,
  report: BackfillReport,
  log: (line: string) => void,
): Promise<boolean> {
  const ctx = await store.loadTenantContext(clientId);
  const histories = await store.loadTenantHistories(clientId);
  const tp = planTenant(ctx, histories);
  const summary = summarizeTenant(tp);
  const tr: TenantRunReport = {
    clientId,
    summary,
    applied: 0,
    alreadyDone: 0,
    changed: 0,
    skippedBlocked: summary.wallets.blocked,
    markedBlocked: 0,
    lastWalletId: null,
    walletGuardFailures: [],
    attention: {
      blockedWallets: summary.blockedWallets,
      payoutReversals: [],
      owedClawbacks: { owed: summary.historicalClawbacks.owed, recovered: summary.historicalClawbacks.recovered, count: summary.historicalClawbacks.count },
    },
  };
  report.tenants.push(tr);
  printTenant(tp, summary, log);

  // WP5 payout reversal allocations — planned in DRY_RUN too (the flags go to the owner with the anomaly list).
  const payoutInput = await store.loadPayoutBackfillInput(clientId);
  const pp = planPayoutAllocationBackfill(payoutInput);
  tr.payout = { planned: pp.allocations.length, inserted: 0, outcome: cfg.apply ? 'NONE' : 'DRY_RUN', flags: pp.flags };
  tr.attention.payoutReversals = pp.flags.filter((f) => f.severity !== 'INFO');
  printPayout(clientId, pp.allocations, pp.flags, log);

  if (!cfg.apply) return false;

  const v0BeforeRows = await store.snapshotV0Wallets(clientId);
  tr.v0Before = computeV0(clientId, v0BeforeRows);
  log(`[${clientId}] V0 before: ${JSON.stringify(tr.v0Before)}`);
  const todo = tp.wallets
    .filter((p) => p.status === 'PLANNED')
    .filter((p) => !cfg.resumeAfterWallet || p.walletId > cfg.resumeAfterWallet)
    .slice(0, cfg.maxWallets ?? Number.MAX_SAFE_INTEGER);
  for (const planned of todo) {
    let outcome: ApplyOutcome;
    try {
      outcome = await store.applyWalletPlan(planned.walletId, clientId, (fresh) => decideFresh(fresh, ctx, tp.adjustments, planned));
    } catch (e) {
      if (!(e instanceof WalletGuardError)) throw e;
      // V0 per-wallet guard: the backfill's OWN writes changed this wallet → rolled back; stop writing anything else.
      tr.walletGuardFailures.push({ walletId: e.walletId, diff: e.diff });
      tr.lastWalletId = planned.walletId;
      report.exitCode = 4;
      log(`[${clientId}] ‼ V0 WALLET GUARD: the backfill's writes changed wallet ${e.walletId} (${e.diff.join('; ')}) — rolled back; no further writes`);
      break;
    }
    if (outcome === 'APPLIED') tr.applied++;
    else if (outcome === 'ALREADY_DONE') tr.alreadyDone++;
    else {
      tr.changed++;
      log(`[${clientId}] wallet ${planned.walletId} CHANGED since planning — skipped (re-run picks it up)`);
    }
    tr.lastWalletId = planned.walletId;
    if ((tr.applied + tr.alreadyDone + tr.changed) % 200 === 0) log(`[${clientId}] progress ${tr.applied + tr.alreadyDone + tr.changed}/${todo.length} — cursor ${planned.walletId}`);
  }
  const halted = tr.walletGuardFailures.length > 0;
  if (halted) {
    await finishV0(store, clientId, tr, v0BeforeRows, report, log);
    return true;
  }
  // Q1/Q2: persist every BLOCKED wallet's reason (it keeps today's rules; reversals on it are refused with this reason).
  if (summary.blockedWallets.length > 0) {
    tr.markedBlocked = await store.markWalletsBlocked(clientId, summary.blockedWallets);
    log(`[${clientId}] ${tr.markedBlocked} BLOCKED wallet(s) marked (reason stored) — they keep today's rules; reversals on them are refused until Gifsy fixes them`);
  }

  if (pp.allocations.length > 0) {
    const plannedIdentity = payoutIdentity(pp.allocations);
    const res = await store.applyPayoutPlan(clientId, (fresh) => {
      const again = planPayoutAllocationBackfill(fresh).allocations;
      return payoutIdentity(again) === plannedIdentity ? again : null;
    });
    tr.payout.outcome = res.outcome;
    tr.payout.inserted = res.inserted;
    if (res.outcome === 'CHANGED') {
      log(`[${clientId}] PAYOUT reversal allocations CHANGED since planning — none inserted (re-run picks them up)`);
      report.exitCode = Math.max(report.exitCode, 3);
    } else {
      log(`[${clientId}] PAYOUT reversal allocations inserted: ${res.inserted}`);
    }
  }

  log(`[${clientId}] applied ${tr.applied}, already done ${tr.alreadyDone}, changed ${tr.changed}, blocked ${tr.skippedBlocked}; cursor ${tr.lastWalletId ?? '-'}`);
  log(`[${clientId}] V0 per-wallet guard ✓ — ${tr.applied} wallet(s) written: balances, counters, movement amounts and lots identical before vs after the backfill's writes (same transaction, under the wallet lock)`);
  await finishV0(store, clientId, tr, v0BeforeRows, report, log);
  if (tr.changed > 0) report.exitCode = Math.max(report.exitCode, 3);
  return false;
}

/** V0 tenant reconciliation: every change since the "before" snapshot must be explained by movement rows committed meanwhile. */
async function finishV0(
  store: BackfillStore,
  clientId: string,
  tr: TenantRunReport,
  beforeRows: V0WalletRow[],
  report: BackfillReport,
  log: (line: string) => void,
): Promise<void> {
  const afterRows = await store.snapshotV0Wallets(clientId);
  tr.v0After = computeV0(clientId, afterRows);
  tr.v0Diff = diffV0(tr.v0Before!, tr.v0After);
  const rec = reconcileV0Wallets(beforeRows, afterRows);
  tr.v0Reconciliation = rec;
  log(`[${clientId}] V0 after: ${JSON.stringify(tr.v0After)}`);
  if (!rec.explained) {
    // Owner rule — never a silent pass: a balance/counter change no committed movement row explains is an alarm.
    log(`[${clientId}] ‼ V0 UNEXPLAINED change during APPLY — ${liveActivityLine(rec)}`);
    report.exitCode = 4;
  } else if (rec.identical) {
    log(`[${clientId}] V0 after == before ✓ (no live activity during the run)`);
  } else {
    log(`[${clientId}] V0 ✓ ${liveActivityLine(rec)}`);
  }
}

/** Re-plan under the lock; write only if the result is the very plan that was reviewed/dry-run. */
export function decideFresh(fresh: BfWalletHistory, ctx: BfTenantContext, adj: TenantAdjustments, planned: WalletPlan): WalletPlan | null {
  const p = planWallet(fresh, ctx, adj.downgradeKeys.size ? adj : undefined);
  if (p.status !== 'PLANNED') return null;
  return planIdentity(p) === planIdentity(planned) ? p : null;
}

/** Canonical identity of a payout allocation plan (BigInt-safe). */
export function payoutIdentity(rows: PlannedPayoutAllocation[]): string {
  return JSON.stringify(
    [...rows].sort((a, b) => (a.creditReversalId + a.payoutEntryId < b.creditReversalId + b.payoutEntryId ? -1 : 1)),
    (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
  );
}

function printTenant(tp: TenantPlan, s: TenantSummary, log: (line: string) => void): void {
  const c = s.clientId;
  log(`[${c}] wallets ${s.wallets.total}: planned ${s.wallets.planned} · noop ${s.wallets.noop} · done ${s.wallets.done} · BLOCKED ${s.wallets.blocked}`);
  log(`[${c}] rows to sequence ${s.rowsToSequence} · positions ${JSON.stringify(s.positions)} · allocations ${s.allocations} · Σ debt ${s.totalDebt} · never-negative wallets ${s.neverNegativeWallets}`);
  const hc = s.historicalClawbacks;
  log(`[${c}] historical clawbacks ${hc.count}: requested ${hc.requested} = debt restored ${hc.debtRestored} + recovered ${hc.recovered} + owed ${hc.owed} + shortfall ${hc.shortfall}`);
  log(`[${c}] anomalies BLOCKING ${JSON.stringify(s.anomalies.BLOCKING)} · WARNING ${JSON.stringify(s.anomalies.WARNING)}`);
  for (const d of s.debtWallets) log(`[${c}]   debt wallet ${d.walletId}: B ${d.redeemablePoints} → D ${d.debtPoints} (H ${d.holdings})`);
  for (const p of tp.wallets) {
    for (const a of p.anomalies) log(`[${c}]   ${a.severity} ${a.code} wallet ${a.walletId}${a.txId ? ` tx ${a.txId}` : ''}: ${a.detail}`);
  }
  for (const a of tp.anomalies) log(`[${c}]   ${a.severity} ${a.code}${a.walletId ? ` wallet ${a.walletId}` : ''}: ${a.detail}`);
}

function printPayout(c: string, rows: PlannedPayoutAllocation[], flags: PayoutBackfillFlag[], log: (line: string) => void): void {
  const by = (s: string) => flags.filter((f) => f.severity === s).length;
  log(`[${c}] PAYOUT reversal allocations to insert ${rows.length} · flags BLOCKING ${by('BLOCKING')} · WARNING ${by('WARNING')} · INFO ${by('INFO')}`);
  for (const f of flags) log(`[${c}]   ${f.severity} PAYOUT_${f.code} reversal ${f.creditReversalId}: ${f.detail}`);
}

/** Owner rule: the run ends with ONE block listing everything that needs Gifsy (never only buried in the log). */
function printAttention(t: TenantRunReport, log: (line: string) => void): void {
  const a = t.attention;
  for (const g of t.walletGuardFailures) {
    log(`[${t.clientId}] ‼ ALARM — the backfill's writes changed wallet ${g.walletId} (${g.diff.join('; ')}); rolled back, run stopped (exit 4)`);
  }
  if (t.v0Reconciliation && !t.v0Reconciliation.explained) {
    const r = t.v0Reconciliation;
    log(`[${t.clientId}] ‼ ALARM — V0 unexplained ${r.unexplainedAmount} pts on ${r.unexplained.length} wallet(s) (exit 4): ${r.unexplained.map((u) => `${u.walletId} — ${u.detail}`).join('; ')}`);
  }
  const n = a.blockedWallets.length + a.payoutReversals.length + (a.owedClawbacks.owed > 0 ? 1 : 0);
  if (n === 0) {
    log(`[${t.clientId}] ATTENTION: nothing needs Gifsy`);
    return;
  }
  log(`[${t.clientId}] ⚠ ATTENTION — ${a.blockedWallets.length} wallet(s) need Gifsy, ${a.payoutReversals.length} payout reversal flag(s)${a.owedClawbacks.owed > 0 ? `, historical clawbacks owed ${a.owedClawbacks.owed} pts` : ''}:`);
  for (const w of a.blockedWallets) {
    log(`[${t.clientId}]   WALLET ${w.walletId} BLOCKED — keeps today's earn/redeem/expiry rules; points reversals on it are refused. Reason: ${w.reason}`);
  }
  for (const f of a.payoutReversals) log(`[${t.clientId}]   PAYOUT reversal ${f.creditReversalId} ${f.severity} ${f.code}: ${f.detail}`);
  if (a.owedClawbacks.owed > 0) {
    log(`[${t.clientId}]   historical clawbacks: recovered ${a.owedClawbacks.recovered}, owed ${a.owedClawbacks.owed} (booked as debt — not recovered)`);
  }
}
