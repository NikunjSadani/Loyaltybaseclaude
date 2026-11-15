/**
 * Wallet Reversal Engine — WP6 backfill RUNNER (orchestration over a storage port; no Prisma here).
 *
 * DRY_RUN is the default: per tenant it loads every wallet's history, plans it (backfill-plan.ts → WP0 replay) and prints
 * the summary, the debt wallets and every anomaly — and writes NOTHING. APPLY needs BOTH `BACKFILL_APPLY=true` and
 * `BACKFILL_CONFIRM="APPLY <db>"`, and every run is refused unless `current_database()` == EXPECTED_DB.
 *
 * APPLY, per tenant: V0 snapshot → for each PLANNED wallet (ascending id) ONE transaction that takes the job advisory
 * lock + the wallet row lock, re-reads the wallet's history, re-plans it with the same tenant adjustments and writes only
 * if the fresh plan is IDENTICAL to the planned one (else CHANGED → skipped, picked up by the next run) → V0 snapshot
 * again; any V0 difference is a hard failure (exit 4). A wallet is done once its movementSeq > 0 and every row carries a
 * seq, so re-running is safe and resumes where a crashed run stopped (RESUME_AFTER_WALLET narrows the scan further).
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
import { diffV0, V0Snapshot } from './verify-checks';

export type ApplyOutcome = 'APPLIED' | 'ALREADY_DONE' | 'CHANGED';

export interface BackfillStore {
  currentDatabase(): Promise<string>;
  /** tenants that own at least one wallet, sorted */
  listTenants(): Promise<string[]>;
  loadTenantContext(clientId: string): Promise<BfTenantContext>;
  /** every wallet of the tenant with its full history (read-only, no locks) */
  loadTenantHistories(clientId: string): Promise<BfWalletHistory[]>;
  snapshotV0(clientId: string): Promise<V0Snapshot>;
  /**
   * In ONE transaction: advisory lock, `SELECT … FROM wallets WHERE id = $1 FOR UPDATE`, re-read the wallet history,
   * then `decide(fresh)`: null → CHANGED (no writes); a plan → write it with guarded statements (every guard must match
   * exactly one row or the transaction rolls back). movementSeq > 0 after the lock → ALREADY_DONE.
   */
  applyWalletPlan(walletId: string, clientId: string, decide: (fresh: BfWalletHistory) => WalletPlan | null): Promise<ApplyOutcome>;
}

export interface BackfillConfig {
  expectedDb: string | undefined;
  apply: boolean;
  confirm: string | undefined;
  tenants?: string[];
  /** APPLY a tenant even though some of its wallets are BLOCKED (those wallets are skipped). Default false. */
  allowBlocked: boolean;
  /** only wallets with id > this (ascending scan) */
  resumeAfterWallet?: string;
  /** max wallets to apply in this run (per tenant) — for a staged first run */
  maxWallets?: number;
}

export interface TenantRunReport {
  clientId: string;
  summary: TenantSummary;
  applied: number;
  alreadyDone: number;
  changed: number;
  skippedBlocked: number;
  lastWalletId: string | null;
  v0Before?: V0Snapshot;
  v0After?: V0Snapshot;
  v0Diff?: string[];
  refused?: string;
}

export interface BackfillReport {
  database: string | null;
  mode: 'DRY_RUN' | 'APPLY';
  tenants: TenantRunReport[];
  exitCode: number;
  error?: string;
}

/** Exit codes: 0 ok · 2 guard refused · 3 tenant refused (blocked wallets) or wallets CHANGED · 4 V0 changed (ALARM). */
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
    const ctx = await store.loadTenantContext(clientId);
    const histories = await store.loadTenantHistories(clientId);
    const tp = planTenant(ctx, histories);
    const summary = summarizeTenant(tp);
    const tr: TenantRunReport = { clientId, summary, applied: 0, alreadyDone: 0, changed: 0, skippedBlocked: summary.wallets.blocked, lastWalletId: null };
    report.tenants.push(tr);
    printTenant(tp, summary, log);

    if (!cfg.apply) continue;
    if (summary.wallets.blocked > 0 && !cfg.allowBlocked) {
      tr.refused = `${summary.wallets.blocked} wallet(s) BLOCKED — resolve the anomalies (or set ALLOW_BLOCKED=true to backfill the rest)`;
      log(`[${clientId}] APPLY REFUSED: ${tr.refused}`);
      report.exitCode = Math.max(report.exitCode, 3);
      continue;
    }
    tr.v0Before = await store.snapshotV0(clientId);
    log(`[${clientId}] V0 before: ${JSON.stringify(tr.v0Before)}`);
    const todo = tp.wallets
      .filter((p) => p.status === 'PLANNED')
      .filter((p) => !cfg.resumeAfterWallet || p.walletId > cfg.resumeAfterWallet)
      .slice(0, cfg.maxWallets ?? Number.MAX_SAFE_INTEGER);
    for (const planned of todo) {
      const outcome = await store.applyWalletPlan(planned.walletId, clientId, (fresh) => decideFresh(fresh, ctx, tp.adjustments, planned));
      if (outcome === 'APPLIED') tr.applied++;
      else if (outcome === 'ALREADY_DONE') tr.alreadyDone++;
      else {
        tr.changed++;
        log(`[${clientId}] wallet ${planned.walletId} CHANGED since planning — skipped (re-run picks it up)`);
      }
      tr.lastWalletId = planned.walletId;
      if ((tr.applied + tr.alreadyDone + tr.changed) % 200 === 0) log(`[${clientId}] progress ${tr.applied + tr.alreadyDone + tr.changed}/${todo.length} — cursor ${planned.walletId}`);
    }
    tr.v0After = await store.snapshotV0(clientId);
    tr.v0Diff = diffV0(tr.v0Before, tr.v0After);
    log(`[${clientId}] applied ${tr.applied}, already done ${tr.alreadyDone}, changed ${tr.changed}, blocked ${tr.skippedBlocked}; cursor ${tr.lastWalletId ?? '-'}`);
    if (tr.v0Diff.length) {
      // Balances/counters are never written by the backfill — a difference means concurrent wallet traffic during the
      // run (or a bug). Either way the owner must look before anything else proceeds.
      log(`[${clientId}] ‼ V0 CHANGED during APPLY: ${tr.v0Diff.join('; ')}`);
      report.exitCode = 4;
    } else {
      log(`[${clientId}] V0 after == before ✓`);
    }
    if (tr.changed > 0) report.exitCode = Math.max(report.exitCode, 3);
  }
  log(`done — exit ${report.exitCode}`);
  return report;
}

/** Re-plan under the lock; write only if the result is the very plan that was reviewed/dry-run. */
export function decideFresh(fresh: BfWalletHistory, ctx: BfTenantContext, adj: TenantAdjustments, planned: WalletPlan): WalletPlan | null {
  const p = planWallet(fresh, ctx, adj.downgradeKeys.size ? adj : undefined);
  if (p.status !== 'PLANNED') return null;
  return planIdentity(p) === planIdentity(planned) ? p : null;
}

function printTenant(tp: TenantPlan, s: TenantSummary, log: (line: string) => void): void {
  const c = s.clientId;
  log(`[${c}] wallets ${s.wallets.total}: planned ${s.wallets.planned} · noop ${s.wallets.noop} · done ${s.wallets.done} · BLOCKED ${s.wallets.blocked}`);
  log(`[${c}] rows to sequence ${s.rowsToSequence} · positions ${JSON.stringify(s.positions)} · allocations ${s.allocations} · Σ debt ${s.totalDebt} · never-negative wallets ${s.neverNegativeWallets}`);
  log(`[${c}] anomalies BLOCKING ${JSON.stringify(s.anomalies.BLOCKING)} · WARNING ${JSON.stringify(s.anomalies.WARNING)}`);
  for (const d of s.debtWallets) log(`[${c}]   debt wallet ${d.walletId}: B ${d.redeemablePoints} → D ${d.debtPoints} (H ${d.holdings})`);
  for (const p of tp.wallets) {
    for (const a of p.anomalies) log(`[${c}]   ${a.severity} ${a.code} wallet ${a.walletId}${a.txId ? ` tx ${a.txId}` : ''}: ${a.detail}`);
  }
  for (const a of tp.anomalies) log(`[${c}]   ${a.severity} ${a.code}${a.walletId ? ` wallet ${a.walletId}` : ''}: ${a.detail}`);
}
