import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma, VoucherDispersalCampaignStatus as CS, VoucherDispersalRowStatus as RS } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  HubbleOrderResult,
  HubblePlaceOrderRejectedError,
  HubbleService,
  hubbleAccountFingerprintMatches,
} from '../hubble/hubble.service';
import { checkHubbleCanaryOrder } from '../hubble/hubble-canary';
import { hubbleVoucherCredentials } from '../hubble/hubble-voucher';
import { isAmountIssuable } from '../rewards/hubble-catalog.helpers';
import { maskVoucherCodeForAudit, voucherCodeVar, whatsappSafeVar } from '../rewards/voucher-issuance';
import { NotificationsService } from '../notifications/notifications.service';
import { VARIABLE_CONTRACTS, whatsappTemplateDefault } from '../notification-templates/notification-templates.config';

/**
 * Voucher Dispersal — the BUY + SEND engine (MONEY: spends real money on the platform Hubble account).
 *
 * The Hubble safety rules are the SAME owner decisions RewardsService applies to redemption orders:
 *  1. NEVER BUY TWICE for a row. Each row carries ONE idempotency key (`hubbleReferenceId`), written at
 *     upload — BEFORE any Hubble call — and reused on every indeterminate retry. A row is only ever sent
 *     to Hubble from status QUEUED, after an atomic QUEUED→BUYING claim (one winner across instances).
 *     A BUYING / PENDING_RECONCILE row is NEVER placed again by the engine — only looked up by reference.
 *  2. Timeout / 5xx / network / unknown ≠ "not bought". Only a DEFINITIVE answer moves a row to
 *     BUY_FAILED: Hubble's own FAILED body, or a definitive 400/422 rejection whose "no order" lookup is
 *     verified by the CANARY (a known delivered order on the same account is found through the same route).
 *     Everything else → PENDING_RECONCILE, reconciled by lookup-by-reference (sweep + Hubble webhook).
 *  3. Hubble's "no such order" is trusted only with the canary, and a manual retry of an indeterminate
 *     row is allowed only 2 hours after the last place attempt (VoucherDispersalService.retryBuy).
 *  4. BUDGET can never be exceeded: every claim re-checks Σ(BUYING+PENDING_RECONCILE+BOUGHT) + this row
 *     ≤ budget while holding the campaign row lock (the same lock confirm / cancel take).
 *  5. Codes never reach a log line, an audit row (masked only) or an admin response.
 *
 * DRIVERS (all idempotent and safe to run concurrently — every transition is a guarded updateMany):
 *  - POST /v1/admin/voucher-dispersal/campaigns/:id/process — bounded, IN-REQUEST pass the admin UI calls
 *    while the campaign page is open (Cloud Run throttles CPU outside a request, so in-request work is
 *    the reliable driver);
 *  - POST /v1/voucher-dispersal/drain — Cloud Scheduler (x-drain-secret), the restart-proof fallback;
 *  - @Interval(30 s) on each instance (best-effort while the instance has CPU);
 *  - a post-confirm kick (best-effort).
 */

/**
 * Rows whose amount counts against the budget — money committed or POSSIBLY committed: BUYING,
 * PENDING_RECONCILE, BOUGHT, and any BUY_FAILED row whose CURRENT reference reached Hubble (Hubble may
 * still hold — or later complete — an order for it). A retry releases such a row only by re-queueing it,
 * and the claim re-checks the budget.
 */
export function budgetCommittedWhere(campaignId: string): Prisma.VoucherDispersalRowWhereInput {
  return {
    campaignId,
    OR: [{ status: { in: [RS.BUYING, RS.PENDING_RECONCILE, RS.BOUGHT] } }, failedMayStillCompleteWhere],
  };
}

/**
 * The ONLY order statuses Hubble documents (owner decision 2026-11-18 — CANCELLED / RETURNED are OUR redemption status
 * names, not Hubble's). Any other answer is an anomaly: never applied, the budget stays reserved, Retry is refused, and
 * an admin's audited "Mark as not bought" is the only way to release it.
 */
export const HUBBLE_KNOWN_STATUSES: ReadonlySet<string> = new Set(['SUCCESS', 'PROCESSING', 'FAILED']);
/**
 * BUY_FAILED sources that NO LONGER count against the budget: `REJECTED` (refused + canary-verified no order) and
 * `MARKED_NOT_BOUGHT` (an admin decided, with a reason, after an unrecognised Hubble answer).
 */
export const NOT_BOUGHT_FAILURE_SOURCES = ['REJECTED', 'MARKED_NOT_BOUGHT'];
/** Campaign-level alert: Hubble reported activity on an EARLIER (superseded) reference of a row (not counted). */
export const SUPERSEDED_ALERT_EVENT = 'VOUCHER_DISPERSAL_SUPERSEDED_REFERENCE_ACTIVITY';

/**
 * A row an admin marked "not bought" is CLOSED: every write guarded on status BUY_FAILED also carries this, so a racing
 * webhook / sweep / retry lookup can never buy or move it (those paths fall through to an alert). OR-wrapped so a NULL
 * source is never dropped by `not`.
 */
export const NOT_MARKED: Prisma.VoucherDispersalRowWhereInput = {
  OR: [{ buyFailureSource: null }, { buyFailureSource: { not: 'MARKED_NOT_BOUGHT' } }],
};
/** After the pass deadline, settles continue only within this grace (the request must still answer in time). */
export const SETTLE_GRACE_MS = 5_000;

/** True when the row's last lookup result is a Hubble status we do not recognise (e.g. "HUBBLE_WEIRD"). */
export function lastLookupUnrecognised(r: { lastReconcileResult: string | null; pendingReason?: string | null; status: string }): boolean {
  const m = /^HUBBLE_(.*)$/.exec(r.lastReconcileResult ?? '');
  // The LATEST lookup decides: a documented answer (or "no order yet") clears the marker (review M4).
  if (r.lastReconcileResult === 'NO_ORDER_AT_HUBBLE_YET' || (m && HUBBLE_KNOWN_STATUSES.has(m[1]))) return false;
  if (m) return true;
  return r.status === RS.PENDING_RECONCILE && (r.pendingReason ?? '').startsWith('HUBBLE_UNKNOWN_STATUS');
}

/** Seconds of every drain pass kept for settling campaigns (capped at a quarter of a short pass). */
export const SETTLE_RESERVE_MS = 10_000;
/** Campaigns settled in a pass even when the deadline has passed (besides the ones touched in this pass). */
export const MIN_SETTLES_PER_PASS = 5;

/**
 * A BUY_FAILED row Hubble may still complete: its CURRENT reference reached Hubble, and the failure is NOT a
 * `REJECTED` one (Hubble refused the order AND the canary verified "no order" — owner decision 2026-11-18:
 * released from the budget). `HUBBLE_FAILED` (Hubble's own FAILED body) keeps counting: `applyBody` still
 * delivers a later SUCCESS for it. OR-wrapped so a NULL source is never dropped by `not`.
 */
export const failedMayStillCompleteWhere: Prisma.VoucherDispersalRowWhereInput = {
  status: RS.BUY_FAILED,
  referenceSentAt: { not: null },
  OR: [{ buyFailureSource: null }, { buyFailureSource: { notIn: NOT_BOUGHT_FAILURE_SOURCES } }],
};

/**
 * Options for every transaction that takes the campaign row lock (edit, confirm, batch upload / confirm /
 * discard, cancel, buy claim, retry re-queue, settle). `maxWait` = how long to wait for a CONNECTION from the
 * pool (kept short: 5 s, so a click never hangs ~a minute); `timeout` = the whole transaction INCLUDING the wait
 * for the campaign row lock (30 s — longer than the longest holder, a ≤ 5,000-row batch insert, so the others
 * don't fail with P2028 at Prisma's 5 s default).
 */
export const CAMPAIGN_LOCK_TX = { timeout: 30_000, maxWait: 5_000 } as const;

/** Consecutive failed settles of one campaign before it is surfaced (audit + `settleError` + banner). */
export const SETTLE_FAILURES_BEFORE_ALERT = 3;

/**
 * The re-settle a webhook / retry lookup triggers right after changing a row: short (a busy campaign lock must
 * not hold the webhook ~30 s). On failure it is left to the next drain pass and NOT counted as a settle failure.
 */
export const WEBHOOK_SETTLE_TX = { timeout: 3_000, maxWait: 3_000 } as const;
/** The earlier-order alert update: lock the alert row, merge, write — short. */
export const ALERT_UPDATE_TX = { timeout: 5_000, maxWait: 5_000 } as const;

/** An alert's history keeps the latest N reports (consecutive duplicates removed) — review of 4d8454ad, L2. */
export const ALERT_HISTORY_CAP = 20;
/**
 * OUR labels on an alert (never a Hubble status): prefixed `__` so no raw Hubble string can collide with them. Raw
 * Hubble statuses are only ever compared with the documented SUCCESS / PROCESSING / FAILED (release gate on b587d42c, M2).
 */
export const ALERT_LOOKUP_FAILED = '__LOOKUP_FAILED';
export const ALERT_NO_ORDER = '__NO_ORDER';
/** A "no order" whose canary is not (yet) verified — not proof; the alert stays open. */
export const ALERT_NO_ORDER_UNVERIFIED = '__NO_ORDER_UNVERIFIED';
/** The row itself took Hubble's answer (bought / back with Hubble). */
export const ALERT_APPLIED = '__APPLIED';
/** A raw Hubble status as stored on an alert: upper-cased, never empty, never starting with our `__` prefix. */
export function hubbleAlertStatus(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/^_+/, '') || 'UNKNOWN';
}
/**
 * Answers that may RESOLVE an alert: Hubble FAILED, a canary-verified "no order", or APPLIED. Only an alert that never
 * saw anything stronger than PROCESSING is resolved (release-gate H1).
 */
export const ALERT_RESOLVING_STATUSES: ReadonlySet<string> = new Set(['FAILED', ALERT_NO_ORDER, ALERT_APPLIED]);
/** Row marker (lastReconcileResult): an unverified "no order" on a failed row — the sweep keeps re-checking it (M3). */
export const RECHECK_NO_ORDER_UNVERIFIED = 'NO_ORDER_UNVERIFIED_RECHECK';
/** Failed rows a webhook lookup failure leaves for the sweep to re-check until Hubble answers (release-gate H2). */
export const RECHECK_AFTER_LOOKUP_FAILURE_SOURCES = ['HUBBLE_FAILED', 'REJECTED'];
/** At most this many of those rows are re-checked per reconcile pass (the pending rows keep their own 20). */
export const RECHECK_AFTER_LOOKUP_FAILURE_PER_PASS = 5;
export type OrderAlertKind = 'SUPERSEDED' | 'MARKED_NOT_BOUGHT' | 'NOT_APPLIED';
/**
 * What an alert's reference IS to its row only ever moves one way (VD follow-up 2026-11-19): the row's current order
 * that could not be applied (NOT_APPLIED) -> the order of a row an admin then marked not bought (MARKED_NOT_BOUGHT) ->
 * an earlier order retired by a retry (SUPERSEDED). A report arriving with a higher kind upgrades the alert (audited
 * as a kind change); a lower one never downgrades it (e.g. a stale sweep snapshot still calling it NOT_APPLIED).
 */
export function alertKindRank(kind: string): number {
  return kind === 'SUPERSEDED' ? 2 : kind === 'MARKED_NOT_BOUGHT' ? 1 : 0;
}
/** Plain words for an alert kind (logs). */
export function alertKindWords(kind: string): string {
  return kind === 'SUPERSEDED'
    ? 'an EARLIER order (retired by a retry)'
    : kind === 'MARKED_NOT_BOUGHT'
      ? 'the order of a row marked NOT BOUGHT'
      : "the row's CURRENT order";
}
/** Context for an alert's log + audit (e.g. the row's status when its own order cannot be applied). */
export type OrderAlertContext = {
  rowStatus?: string;
  onlyIfExists?: boolean;
  /** For ALERT_NO_ORDER: true only when the caller verified the canary (the sweep — never the webhook). */
  noOrderVerified?: boolean;
  /** Extra facts for the campaign alert audit (e.g. Hubble's order id) — written only when the alert really changes. */
  auditExtra?: Record<string, unknown>;
};

/**
 * How serious a reported status is for an alert — the STRONGEST real one is kept (H1): SUCCESS (a voucher was issued)
 * > an unrecognised status > PROCESSING. LOOKUP_FAILED / FAILED / NO_ORDER are not activity (0).
 */
export function alertStatusRank(status: string): number {
  if (status === 'SUCCESS') return 3;
  if (status === 'PROCESSING') return 1;
  if (status === 'FAILED' || status.startsWith('__')) return 0; // FAILED or one of OUR labels
  return 2;
}

/** Append a report to an alert history: consecutive duplicates removed, latest ALERT_HISTORY_CAP kept. */
export function appendAlertHistory(history: readonly string[], status: string): string[] {
  const next = history[history.length - 1] === status ? [...history] : [...history, status];
  return next.slice(-ALERT_HISTORY_CAP);
}
/**
 * ONE definition of "can still cost this campaign money" — the buy-time guard (`budgetCommittedWhere`, which
 * is this minus QUEUED: the row being claimed is the one queued amount it adds), the budget floor (edit),
 * batch confirm, the retry check and the detail page's budget breakdown all use it:
 *   BOUGHT (spent) · BUYING + PENDING_RECONCILE (with Hubble, not yet confirmed) · BUY_FAILED Hubble may still
 *   complete (`failedMayStillCompleteWhere` — REJECTED excluded) · QUEUED (confirmed, not yet bought).
 */
export function mayStillCostWhere(campaignId: string, excludeRowId?: string): Prisma.VoucherDispersalRowWhereInput {
  return {
    campaignId,
    ...(excludeRowId ? { id: { not: excludeRowId } } : {}),
    OR: [{ status: { in: [RS.QUEUED, RS.BUYING, RS.PENDING_RECONCILE, RS.BOUGHT] } }, failedMayStillCompleteWhere],
  };
}

export interface BudgetBreakdown {
  spentPaise: bigint;
  withHubblePaise: bigint;
  failedMayCompletePaise: bigint;
  queuedPaise: bigint;
  /** Σ of the four — the lowest the budget may go; budget − floor is what is left. */
  floorPaise: bigint;
}

/**
 * Over budget = money already spent or with Hubble (spent + with Hubble + failed purchases Hubble may still
 * complete) beyond the budget — QUEUED rows are NOT spending (re-review M1). Queued rows that no longer fit are
 * reported apart as "at risk" (the buy-time guard will refuse them).
 */
export function overBudget(b: BudgetBreakdown, budgetPaise: bigint): { committedPaise: bigint; overPaise: bigint; queuedAtRiskPaise: bigint } {
  const committedPaise = b.spentPaise + b.withHubblePaise + b.failedMayCompletePaise;
  const overPaise = committedPaise > budgetPaise ? committedPaise - budgetPaise : 0n;
  const left = budgetPaise - committedPaise;
  const fits = left > 0n ? left : 0n;
  const queuedAtRiskPaise = b.queuedPaise > fits ? b.queuedPaise - fits : 0n;
  return { committedPaise, overPaise, queuedAtRiskPaise };
}

/** The breakdown of `mayStillCostWhere` (optionally without one row — e.g. the row being retried). */
export async function budgetBreakdown(db: Prisma.TransactionClient | PrismaService, campaignId: string, excludeRowId?: string): Promise<BudgetBreakdown> {
  const groups = await db.voucherDispersalRow.groupBy({
    by: ['status'],
    where: mayStillCostWhere(campaignId, excludeRowId),
    _sum: { amountPaise: true },
  });
  const sum = (ss: RS[]) => groups.filter((g) => ss.includes(g.status)).reduce((a, g) => a + BigInt(g._sum.amountPaise ?? 0n), 0n);
  const b = {
    spentPaise: sum([RS.BOUGHT]),
    withHubblePaise: sum([RS.BUYING, RS.PENDING_RECONCILE]),
    failedMayCompletePaise: sum([RS.BUY_FAILED]),
    queuedPaise: sum([RS.QUEUED]),
  };
  return { ...b, floorPaise: b.spentPaise + b.withHubblePaise + b.failedMayCompletePaise + b.queuedPaise };
}

/** BUY_FAILED sources that are decided by US (not by Hubble) — when the reference reached Hubble earlier, the row stays in the reconcile sweep. */
export const LOCAL_FAILURE_SOURCES = ['BUDGET', 'NOT_SENT'];
/** A BUYING claim older than this is treated as "the worker died mid-call" → reconcile by lookup only. */
export const STALE_BUYING_MS = 5 * 60 * 1000;
/** Minimum gap between automatic reconcile lookups of one pending row. */
export const RECONCILE_EVERY_MS = 2 * 60 * 1000;
/** A message claim with no recorded outcome after this is surfaced as "unknown — use Resend". */
export const STALE_MESSAGE_CLAIM_MS = 30 * 60 * 1000;
/** Owner/coordinator rule: at most this many manual resends per row. */
export const MAX_RESENDS = 3;
/** Owner rule: an indeterminate row may be manually re-placed only this long after its last attempt. */
export const DISPERSAL_RETRY_MIN_AGE_MS = 2 * 60 * 60 * 1000;
/** Throttle between Hubble place calls inside one pass. */
export const BUY_GAP_MS = 300;
/**
 * The platform (Gifsy) tenant id. ALL dispersal WhatsApp receipts are filed here — never under the
 * billed client (coordinator decision 2026-11-16: client admins must not see these phone numbers in
 * their tenant delivery report, nor count them in tenant WhatsApp stats).
 */
export const GIFSY_PLATFORM_CLIENT_ID = 'gifsy';
export const DISPERSAL_EVENT_KEY = 'VOUCHER_DISPERSAL';

export interface DrainSummary {
  skipped?: 'busy';
  staleRecovered: number;
  reconciled: number;
  bought: number;
  pending: number;
  failed: number;
  messagesSent: number;
  campaignsFinished: number;
}

type Row = Prisma.VoucherDispersalRowGetPayload<Record<string, never>>;

export type ReconcileOutcome =
  | 'BOUGHT'
  | 'BUY_FAILED'
  | 'PENDING'
  | 'NO_ORDER'
  | 'LOOKUP_FAILED'
  | 'NOT_CONFIGURED'
  | 'NOT_FOUND'
  | 'SKIPPED'
  /** Hubble's answer changes nothing on the row (e.g. FAILED again for a failed row, or an anomaly left as is). */
  | 'UNCHANGED';

@Injectable()
export class VoucherDispersalProcessor {
  private readonly logger = new Logger(VoucherDispersalProcessor.name);
  private running = false;
  /** Touched campaigns a pass ran out of time to settle — settled first by the next pass on this instance. */
  private readonly carryOver = new Set<string>();
  /** Test seam: the pause between buys. */
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubble: HubbleService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Best-effort timer driver (Cloud Run may throttle it; the scheduler drain + in-request pass cover that). */
  @Interval(30_000)
  async tick(): Promise<void> {
    if (process.env.VOUCHER_DISPERSAL_WORKER_ENABLED === 'false') return;
    try {
      await this.drain();
    } catch (e) {
      this.logger.error(`[dispersal] tick failed: ${e}`);
    }
  }

  /** Fire-and-forget pass (post-confirm / post-retry). Never throws. */
  kick(campaignId?: string): void {
    setImmediate(() => {
      void this.drain({ campaignId }).catch((e) => this.logger.error(`[dispersal] kick failed: ${e}`));
    });
  }

  /**
   * One bounded pass. Order: recover stale BUYING claims → reconcile pending rows → send messages for
   * bought rows → buy QUEUED rows (throttled, time-boxed) → mirror WhatsApp statuses → finish campaigns.
   * One pass per instance at a time (a concurrent call returns { skipped: 'busy' }); across instances
   * the per-row guarded claims make concurrent passes safe.
   */
  async drain(opts: { campaignId?: string; budgetMs?: number; maxBuys?: number } = {}): Promise<DrainSummary> {
    const s: DrainSummary = { staleRecovered: 0, reconciled: 0, bought: 0, pending: 0, failed: 0, messagesSent: 0, campaignsFinished: 0 };
    if (this.running) return { ...s, skipped: 'busy' };
    this.running = true;
    const deadline = Date.now() + (opts.budgetMs ?? 45_000);
    try {
      s.staleRecovered = await this.step('stale', () => this.recoverStaleBuying(opts.campaignId), 0);
      const touched = new Set<string>();
      const timeLeft = () => Date.now() <= deadline;
      if (timeLeft()) s.reconciled = await this.step('reconcile', () => this.reconcilePending(opts.campaignId, deadline, touched), 0);
      if (timeLeft()) s.messagesSent += await this.step('messages', () => this.sendPendingMessages(opts.campaignId, deadline), 0);
      const staleMsg = await this.step('stale-messages', () => this.surfaceStaleMessageClaims(opts.campaignId), [] as string[]);
      staleMsg.forEach((id) => touched.add(id));
      // F3: stop buying early enough that this pass can still settle its campaigns.
      const reserve = Math.max(0, Math.min(SETTLE_RESERVE_MS, Math.floor((opts.budgetMs ?? 45_000) / 4)));
      const buys = await this.step('buy', () => this.buyQueued(opts.campaignId, deadline - reserve, opts.maxBuys ?? 50), null);
      if (buys) {
        s.bought = buys.bought;
        s.pending = buys.pending;
        s.failed = buys.failed;
        s.messagesSent += buys.messagesSent;
      }
      const mirrored = await this.step('mirror', () => this.mirrorMessageStatuses(opts.campaignId), [] as string[]);
      mirrored.forEach((id) => touched.add(id));
      s.campaignsFinished = await this.step('finish', () => this.finishCampaigns(opts.campaignId, [...touched], deadline), 0);
    } finally {
      this.running = false;
    }
    return s;
  }

  private async step<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.logger.error(`[dispersal] drain step "${name}" failed: ${e}`);
      return fallback;
    }
  }

  // ─── 1. Stale BUYING claims ───────────────────────────────────────────────────

  /** A BUYING claim older than STALE_BUYING_MS: the worker died around the place call → lookup only. */
  async recoverStaleBuying(campaignId?: string): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_BUYING_MS);
    const rows = await this.prisma.voucherDispersalRow.findMany({
      where: { status: RS.BUYING, buyingAt: { lt: cutoff }, ...(campaignId ? { campaignId } : {}) },
      select: { id: true },
      take: 200,
    });
    let n = 0;
    for (const r of rows) {
      const res = await this.prisma.voucherDispersalRow.updateMany({
        where: { id: r.id, status: RS.BUYING, buyingAt: { lt: cutoff } },
        data: { status: RS.PENDING_RECONCILE, pendingReason: 'STALE_BUYING', pendingSince: new Date(), claimToken: null },
      });
      if (res.count === 1) {
        n++;
        await this.audit(r.id, 'VOUCHER_DISPERSAL_PENDING', { reason: 'STALE_BUYING' });
      }
    }
    return n;
  }

  // ─── 2. Reconcile ─────────────────────────────────────────────────────────────

  async reconcilePending(campaignId: string | undefined, deadline: number, touched?: Set<string>): Promise<number> {
    if (!this.hubble.isConfigured()) return 0;
    const cutoff = new Date(Date.now() - RECONCILE_EVERY_MS);
    const rows = await this.prisma.voucherDispersalRow.findMany({
      where: {
        AND: [
          {
            OR: [
              { status: RS.PENDING_RECONCILE },
              // A local failure (budget / not issuable) on a row whose reference reached Hubble EARLIER:
              // Hubble may still complete that earlier order — keep looking.
              { status: RS.BUY_FAILED, referenceSentAt: { not: null }, buyFailureSource: { in: LOCAL_FAILURE_SOURCES } },
            ],
          },
          { OR: [{ lastReconcileAt: null }, { lastReconcileAt: { lt: cutoff } }] },
        ],
        ...(campaignId ? { campaignId } : {}),
      },
      orderBy: { updatedAt: 'asc' },
      take: 20,
    });
    // Release-gate H2: a FAILED row whose CURRENT reference could not be looked up (a webhook said Hubble has news) is
    // re-checked every pass until Hubble answers — bounded per pass.
    const recheck = await this.prisma.voucherDispersalRow.findMany({
      where: {
        status: RS.BUY_FAILED,
        buyFailureSource: { in: RECHECK_AFTER_LOOKUP_FAILURE_SOURCES },
        AND: [
          { OR: [{ lastReconcileResult: { startsWith: 'LOOKUP_FAILED' } }, { lastReconcileResult: RECHECK_NO_ORDER_UNVERIFIED }] },
          { OR: [{ lastReconcileAt: null }, { lastReconcileAt: { lt: cutoff } }] },
        ],
        ...(campaignId ? { campaignId } : {}),
      },
      orderBy: { lastReconcileAt: 'asc' },
      take: RECHECK_AFTER_LOOKUP_FAILURE_PER_PASS,
    });
    let n = 0;
    for (const row of [...rows, ...recheck.filter((r) => !rows.some((x) => x.id === r.id))]) {
      if (Date.now() > deadline) break;
      const outcome = await this.reconcileRow(row);
      // A row that changed state may move a FINISHED campaign back in flight (or settle it) — re-settle.
      if (outcome === 'BOUGHT' || outcome === 'PENDING' || outcome === 'BUY_FAILED') touched?.add(row.campaignId);
      n++;
    }
    if (Date.now() <= deadline) n += await this.recheckUnverifiedNoOrderAlerts(campaignId, deadline, cutoff);
    return n;
  }

  /**
   * M1/M3 (release gate on b587d42c): an alert whose latest answer is an UNVERIFIED "no order" (the webhook never runs
   * the canary) is re-looked up here and, if Hubble still has no order, the canary decides — resolved only when verified.
   * Bounded per pass; backs off by the alert's own updatedAt. A failed row's own alert is left to the row re-check above.
   */
  async recheckUnverifiedNoOrderAlerts(campaignId: string | undefined, deadline: number, cutoff: Date): Promise<number> {
    const list = await this.prisma.voucherDispersalOrderAlert.findMany({
      where: { resolvedAt: null, noOrderUnverifiedAt: { not: null }, updatedAt: { lt: cutoff }, ...(campaignId ? { campaignId } : {}) },
      orderBy: { noOrderUnverifiedAt: 'asc' },
      take: RECHECK_AFTER_LOOKUP_FAILURE_PER_PASS,
    });
    let n = 0;
    for (const a of list) {
      if (Date.now() > deadline) break;
      const kind = a.kind as OrderAlertKind;
      if (kind === 'NOT_APPLIED') {
        const own = await this.prisma.voucherDispersalRow.findFirst({ where: { id: a.rowId }, select: { status: true, buyFailureSource: true, hubbleReferenceId: true } });
        if (own?.hubbleReferenceId === a.referenceId && own.status === RS.BUY_FAILED && RECHECK_AFTER_LOOKUP_FAILURE_SOURCES.includes(own.buyFailureSource ?? '')) continue;
      }
      const row = { id: a.rowId, campaignId: a.campaignId, rowNumber: a.rowNumber, batchNumber: a.batchNumber };
      n++;
      let body: HubbleOrderResult | null;
      try {
        body = await this.hubble.getOrderByReference(a.referenceId);
      } catch (e) {
        this.logger.warn(`[dispersal] re-check of unverified "no order" ${a.referenceId} failed: ${e}`);
        await this.recordOrderAlert(row, a.referenceId, ALERT_LOOKUP_FAILED, kind);
        continue;
      }
      if (body === null) {
        const c = await this.verifyNotFoundCanary(a.referenceId, { maxTries: 3, budgetMs: 10_000 }).catch((e: unknown) => ({ ok: false as const, canaryRef: null, why: String(e) }));
        await this.recordOrderAlert(row, a.referenceId, ALERT_NO_ORDER, kind, { noOrderVerified: c.ok });
      } else {
        await this.recordOrderAlert(row, a.referenceId, hubbleAlertStatus(body.status), kind);
      }
    }
    return n;
  }

  /**
   * Look the row's CURRENT reference up at Hubble and apply what Hubble says. Never places an order.
   * "No order" is only recorded (never fails the row) — a manual retry decides, under the 2 h + canary rule.
   */
  async reconcileRow(row: Row, opts: { webhook?: boolean } = {}): Promise<ReconcileOutcome> {
    if (!this.hubble.isConfigured()) return 'NOT_CONFIGURED';
    if (!row.hubbleReferenceId) return 'SKIPPED';
    // Release-gate H2: the row's previous lookup failed (and may carry a "couldn't check" alert) — whatever Hubble
    // answers now settles that alert (only if it exists).
    const followUp =
      row.status === RS.BUY_FAILED &&
      RECHECK_AFTER_LOOKUP_FAILURE_SOURCES.includes(row.buyFailureSource ?? '') &&
      ((row.lastReconcileResult ?? '').startsWith('LOOKUP_FAILED') || row.lastReconcileResult === RECHECK_NO_ORDER_UNVERIFIED);
    const settleAlert = async (status: string, extra: Partial<OrderAlertContext> = {}) => {
      if (followUp && row.hubbleReferenceId) {
        await this.recordOrderAlert(row, row.hubbleReferenceId, status, 'NOT_APPLIED', { rowStatus: row.status, onlyIfExists: true, ...extra });
      }
    };
    let body: HubbleOrderResult | null;
    try {
      body = await this.hubble.getOrderByReference(row.hubbleReferenceId);
    } catch (e) {
      await this.noteReconcile(row, `LOOKUP_FAILED: ${String(e).slice(0, 200)}`);
      await settleAlert(ALERT_LOOKUP_FAILED);
      return 'LOOKUP_FAILED';
    }
    if (body === null && followUp) {
      // M1/M3: "no order" for a failed row Hubble had news about is definitive only with a verified canary — run by the
      // sweep, NEVER in the webhook. Unverified → the row keeps a re-check marker (stays in the sweep) and the alert
      // stays open ("no order (unverified)").
      const c = opts.webhook
        ? { ok: false as const, why: 'not run in the webhook' }
        : await this.verifyNotFoundCanary(row.hubbleReferenceId, { maxTries: 3, budgetMs: 10_000 }).catch((e: unknown) => ({ ok: false as const, why: String(e) }));
      await this.noteReconcile(row, c.ok ? 'NO_ORDER_AT_HUBBLE_YET' : RECHECK_NO_ORDER_UNVERIFIED);
      await settleAlert(ALERT_NO_ORDER, { noOrderVerified: c.ok });
      if (!c.ok) this.logger.warn(`[dispersal] row ${row.id}: Hubble says no order for ${row.hubbleReferenceId} — not verified (${c.why}); re-checked by the sweep`);
      return 'NO_ORDER';
    }
    if (body === null) {
      await this.noteReconcile(row, 'NO_ORDER_AT_HUBBLE_YET');
      if (row.status === RS.PENDING_RECONCILE && (row.pendingReason ?? '').startsWith('HUBBLE_UNKNOWN_STATUS')) {
        // A definitive later answer clears the "unrecognised" marker → Retry follows the normal rules again (review M4).
        await this.prisma.voucherDispersalRow
          .updateMany({ where: { id: row.id, status: RS.PENDING_RECONCILE, pendingReason: row.pendingReason }, data: { pendingReason: 'NO_ORDER_AT_HUBBLE_YET' } })
          .catch((e: unknown) => this.logger.warn(`[dispersal] could not clear the unrecognised marker on row ${row.id}: ${e}`));
      }
      return 'NO_ORDER';
    }
    await this.noteReconcile(row, `HUBBLE_${String(body.status ?? '').toUpperCase() || 'UNKNOWN'}`);
    const outcome = await this.applyBody(row, body);
    // The row itself took Hubble's answer (bought / back with Hubble) → the alert is settled as APPLIED.
    await settleAlert(outcome === 'BOUGHT' || outcome === 'PENDING' ? ALERT_APPLIED : hubbleAlertStatus(body.status));
    return outcome;
  }

  /** Webhook entry: find the row by reference and reconcile it. NOT_FOUND when no dispersal row owns it. */
  async reconcileByReference(referenceId: string): Promise<ReconcileOutcome> {
    const row = await this.prisma.voucherDispersalRow.findFirst({ where: { hubbleReferenceId: referenceId } });
    if (row && row.status === RS.BUY_FAILED && row.buyFailureSource === 'MARKED_NOT_BOUGHT') {
      // Owner decision: "Mark as not bought" is FINAL — the row is never changed again. Activity Hubble reports on it is
      // alerted loudly (once per status; not counted) for ops to settle with Hubble outside the campaign.
      const r = await this.alertEarlierOrder(row, referenceId, 'MARKED_NOT_BOUGHT');
      return r.status === ALERT_LOOKUP_FAILED ? 'LOOKUP_FAILED' : 'SKIPPED';
    }
    if (row) {
      // BOUGHT: its own order. QUEUED: the next buy places / finds this same reference and applies it.
      if (row.status === RS.BOUGHT || row.status === RS.QUEUED) return 'SKIPPED';
      if (row.status !== RS.BUYING && row.status !== RS.PENDING_RECONCILE && row.status !== RS.BUY_FAILED) {
        // Release-gate H3: e.g. a CANCELLED row whose order reached Hubble — the campaign no longer acts on it, but Hubble
        // may have completed it. Looked up; SUCCESS / PROCESSING / unrecognised → a loud NOT_APPLIED alert. Never silent.
        const r = await this.alertEarlierOrder(row, referenceId, 'NOT_APPLIED', { rowStatus: row.status });
        return r.status === ALERT_LOOKUP_FAILED ? 'LOOKUP_FAILED' : 'SKIPPED';
      }
      // BUYING: the in-flight call will apply the body itself; a lookup now is harmless (guarded) but
      // would double the Hubble traffic — let the pass that owns the claim finish.
      if (row.status === RS.BUYING) return 'SKIPPED';
      const outcome = await this.reconcileRow(row, { webhook: true }); // one lookup, never a canary (M1)
      if (outcome === 'LOOKUP_FAILED' && row.status === RS.BUY_FAILED && RECHECK_AFTER_LOOKUP_FAILURE_SOURCES.includes(row.buyFailureSource ?? '') && row.hubbleReferenceId) {
        // Release-gate H2: Hubble has news about a FAILED row's CURRENT order but we could not read it — alerted
        // ("couldn't check"), and the 2-minute sweep re-checks the row until Hubble answers. The webhook still acks 200.
        await this.recordOrderAlert(row, row.hubbleReferenceId, ALERT_LOOKUP_FAILED, 'NOT_APPLIED', { rowStatus: row.status });
      }
      if (outcome === 'BOUGHT') await this.sendMessage(row.id);
      // Money-review M1: a webhook can move a row of a FINISHED campaign back in flight (or finish it) —
      // re-settle now so the campaign status (and "add more people") never contradicts its rows.
      if (outcome === 'BOUGHT' || outcome === 'PENDING' || outcome === 'BUY_FAILED') await this.resettle(row.campaignId);
      return outcome;
    }
    const superseded = await this.prisma.voucherDispersalRow.findFirst({
      where: { previousReferenceIds: { has: referenceId } },
      select: { id: true, campaignId: true, rowNumber: true, batchNumber: true, amountPaise: true },
    });
    if (!superseded) return 'NOT_FOUND';
    // A webhook for a reference this row no longer uses (retired by a retry): looked up and, if Hubble reports activity
    // on it, alerted loudly — once per reference + status, NOT counted against the budget (owner decision).
    const r = await this.alertEarlierOrder(superseded, referenceId, 'SUPERSEDED');
    return r.status === ALERT_LOOKUP_FAILED ? 'LOOKUP_FAILED' : 'SKIPPED';
  }

  /**
   * Hubble activity on an order this campaign no longer acts on — an EARLIER (superseded) reference of a row, or the
   * reference of a row an admin marked "not bought". Never changes the row, never counted against the budget.
   * SUCCESS / PROCESSING / an undocumented status → a loud alert (one per reference; see recordOrderAlert). FAILED / no
   * order → RESOLVES an existing alert (never creates one). A lookup error is recorded on the alert ("couldn't check" /
   * last check failed) and returned as LOOKUP_FAILED — the webhook still answers 200 (review of 4d8454ad, M3).
   */
  async alertEarlierOrder(
    row: { id: string; campaignId: string; rowNumber: number; batchNumber: number },
    ref: string,
    kind: OrderAlertKind,
    ctx: OrderAlertContext = {},
  ): Promise<{ status: string; alerted: boolean }> {
    // Webhook path: ONE lookup, never the canary (M1) — an unverified "no order" is left to the sweep.
    let status: string;
    try {
      const b = await this.hubble.getOrderByReference(ref);
      status = b === null ? ALERT_NO_ORDER : hubbleAlertStatus(b.status);
    } catch (e) {
      this.logger.error(`[dispersal] could not look up earlier reference ${ref} (campaign ${row.campaignId} row ${row.rowNumber}): ${e}`);
      const alerted = await this.recordOrderAlert(row, ref, ALERT_LOOKUP_FAILED, kind, ctx);
      return { status: ALERT_LOOKUP_FAILED, alerted };
    }
    const alerted = await this.recordOrderAlert(row, ref, status, kind, { ...ctx, noOrderVerified: false });
    return { status, alerted };
  }

  /**
   * ONE alert per (campaign, reference) — the table's unique key makes the first write race-safe. Returns true when a
   * REAL change was recorded (new alert, worsened, resolved, kind upgraded) — those, and only those, get the error log
   * + campaign audit row. Never throws. Rules (review of 4d8454ad):
   * - H1: the strongest real status is kept (SUCCESS > unrecognised > PROCESSING); a lookup failure only sets
   *   lastCheckFailedAt + a history entry (an alert whose ONLY report is a lookup failure shows LOOKUP_FAILED).
   * - H2: FAILED / NO_ORDER resolves an open alert (resolvedAt); activity reported later re-opens it (worsened).
   * - M1: statusChangedAt moves only when the alert is created or worsened (the digest's window key).
   * - M2: an update locks the alert row first (Postgres row lock in a short transaction) and merges under the lock —
   *   two concurrent reports never lose one.
   * - L1: only the unique violation (P2002) means "already alerted"; any other error is logged loudly, not recorded.
   * - L2: history deduped (consecutive) and capped; L3: kind NOT_APPLIED upgrades to SUPERSEDED (never down).
   */
  async recordOrderAlert(
    row: { id: string; campaignId: string; rowNumber: number; batchNumber: number },
    ref: string,
    status: string,
    kind: OrderAlertKind,
    ctx: OrderAlertContext = {},
  ): Promise<boolean> {
    const resolving = ALERT_RESOLVING_STATUSES.has(status);
    const lookupFailed = status === ALERT_LOOKUP_FAILED;
    const where = { campaignId: row.campaignId, referenceId: ref };
    // Release-gate H1 + M1: "no order" resolves only with a canary the CALLER verified (the sweep; never the webhook).
    const canaryOk = status === ALERT_NO_ORDER && ctx.noOrderVerified === true;
    if (!resolving && !ctx.onlyIfExists) {
      try {
        await this.prisma.voucherDispersalOrderAlert.create({
          data: {
            ...where,
            rowId: row.id,
            batchNumber: row.batchNumber,
            rowNumber: row.rowNumber,
            kind,
            hubbleStatus: status,
            statusHistory: [status],
            ...(lookupFailed ? { lastCheckFailedAt: new Date() } : {}),
          },
        });
        this.sayOrderAlert(row, ref, kind, status, 'ALERT —', ctx);
        await this.orderAlertAudit(row, ref, kind, status, { ...(ctx.rowStatus ? { rowStatus: ctx.rowStatus } : {}), ...ctx.auditExtra });
        return true;
      } catch (e) {
        if ((e as { code?: string } | null)?.code !== 'P2002') {
          this.logger.error(`[dispersal] could NOT record the order alert for ${ref} (campaign ${row.campaignId} row ${row.rowNumber}, Hubble ${status}): ${e}`);
          return false;
        }
        // Already alerted for this reference → update it below.
      }
    }
    type Res = { change: 'WORSENED' | 'RESOLVED' | 'CONTRADICTED' | 'KIND' | null; prev: string; prevKind: string; kind: string; kept: string };
    let res: Res | null;
    try {
      res = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        // Row lock FIRST: a concurrent report waits here, then reads the committed state below (M2).
        const locked = await tx.voucherDispersalOrderAlert.updateMany({ where, data: { updatedAt: now } });
        if (locked.count === 0) return null;
        const cur = await tx.voucherDispersalOrderAlert.findFirst({ where });
        if (!cur) return null;
        const strong = alertStatusRank(cur.hubbleStatus) >= 2; // ever saw SUCCESS / an unrecognised status (kept: strongest)
        const unverified = status === ALERT_NO_ORDER && !canaryOk && cur.resolvedAt === null;
        const entry = unverified ? ALERT_NO_ORDER_UNVERIFIED : status;
        const history = cur.statusHistory ?? [];
        const data: Prisma.VoucherDispersalOrderAlertUpdateInput = { statusHistory: appendAlertHistory(history, entry) };
        let change: Res['change'] = null;
        // Kind only moves up (NOT_APPLIED -> MARKED_NOT_BOUGHT -> SUPERSEDED): after a later mark the alert reads as
        // the marked row's order, not "could not be applied to the row" (VD follow-up 2026-11-19).
        const kindUp = alertKindRank(kind) > alertKindRank(cur.kind);
        if (kindUp) data.kind = kind;
        if (!lookupFailed) data.noOrderUnverifiedAt = unverified && !strong ? cur.noOrderUnverifiedAt ?? now : null;
        if (lookupFailed) {
          data.lastCheckFailedAt = now;
        } else if (resolving) {
          if (cur.resolvedAt === null) {
            if (strong) {
              // NEVER resolved: Hubble reported SUCCESS / an unrecognised status before — a paid voucher may exist.
              if (history[history.length - 1] !== entry) change = 'CONTRADICTED';
            } else if (unverified) {
              // Kept open; the sweep re-checks (noOrderUnverifiedAt). With no real status yet, the label says so (M3).
              if (alertStatusRank(cur.hubbleStatus) === 0) data.hubbleStatus = ALERT_NO_ORDER_UNVERIFIED;
            } else {
              Object.assign(data, { resolvedAt: now, hubbleStatus: status });
              change = 'RESOLVED';
            }
          } else if (cur.hubbleStatus !== status) {
            data.hubbleStatus = status; // FAILED <-> NO_ORDER on a resolved alert: not a change worth an audit
          }
        } else {
          const r = alertStatusRank(status);
          const c = alertStatusRank(cur.hubbleStatus);
          const worse = cur.resolvedAt !== null || r > c || (r === 2 && c === 2 && status !== cur.hubbleStatus);
          if (worse) {
            Object.assign(data, { hubbleStatus: status, resolvedAt: null, statusChangedAt: now });
            change = 'WORSENED';
          }
        }
        if (!change && kindUp) change = 'KIND';
        const upd = await tx.voucherDispersalOrderAlert.update({ where: { id: cur.id }, data });
        return { change, prev: cur.hubbleStatus, prevKind: cur.kind, kind: upd.kind, kept: upd.hubbleStatus };
      }, ALERT_UPDATE_TX);
    } catch (e) {
      this.logger.error(`[dispersal] could NOT update the order alert for ${ref} (campaign ${row.campaignId} row ${row.rowNumber}, Hubble ${status}): ${e}`);
      return false;
    }
    if (!res) {
      // Nothing to resolve is normal (FAILED / no order on a reference never alerted); a vanished alert is not.
      if (!resolving && !ctx.onlyIfExists) this.logger.error(`[dispersal] could NOT record the order alert for ${ref} (campaign ${row.campaignId}): the existing alert was not found`);
      return false;
    }
    const k = res.kind as OrderAlertKind;
    if (res.change === null) {
      // Not a real change -> no audit; still never silent in the logs.
      if (lookupFailed) {
        this.logger.warn(`[dispersal] campaign ${row.campaignId} row ${row.rowNumber}: could not check reference ${ref} with Hubble — alert kept at ${res.kept}`);
      } else if (status === ALERT_NO_ORDER && !canaryOk) {
        this.logger.warn(`[dispersal] campaign ${row.campaignId} row ${row.rowNumber}: unverified "no order" for ${ref} — alert kept open at ${res.kept}`);
      } else if (res.prev !== status) {
        this.logger.warn(`[dispersal] campaign ${row.campaignId} row ${row.rowNumber}: Hubble reported ${status} for reference ${ref} — alert kept at ${res.kept} (history updated)`);
      }
      return false;
    }
    if (res.change === 'CONTRADICTED') {
      this.logger.error(
        `[dispersal] campaign ${row.campaignId} batch ${row.batchNumber} row ${row.rowNumber}: alert for reference ${ref} NOT resolved — Hubble now says ${status === 'FAILED' ? 'the order failed' : status === ALERT_APPLIED ? 'it was applied' : canaryOk ? 'there is no order' : 'there is no order (unverified)'}, but it reported ${res.kept} earlier; check with Hubble (a paid voucher may exist)`,
      );
      await this.orderAlertAudit(row, ref, k, res.kept, { contradictedBy: status, ...ctx.auditExtra });
      return true;
    }
    if (res.change === 'RESOLVED') {
      this.logger.warn(
        `[dispersal] campaign ${row.campaignId} batch ${row.batchNumber} row ${row.rowNumber}: alert RESOLVED for reference ${ref} — ${status === 'FAILED' ? 'Hubble confirmed the order failed' : status === ALERT_APPLIED ? "Hubble's answer was applied to the row" : 'Hubble confirmed there is no order (canary verified)'} (was ${res.prev})`,
      );
      await this.orderAlertAudit(row, ref, k, status, { previousStatus: res.prev, resolved: true });
      return true;
    }
    this.sayOrderAlert(
      row,
      ref,
      k,
      res.kept,
      res.change === 'KIND' ? `ALERT UPDATE (now ${alertKindWords(k)}, was ${alertKindWords(res.prevKind)}) —` : `ALERT UPDATE (was ${res.prev}) —`,
      ctx,
    );
    await this.orderAlertAudit(row, ref, k, res.kept, {
      previousStatus: res.prev,
      // A kind change can ride along with a worsened status — both are recorded on the one audit row.
      ...(res.kind !== res.prevKind ? { previousKind: res.prevKind } : {}),
      ...(ctx.rowStatus ? { rowStatus: ctx.rowStatus } : {}),
      ...ctx.auditExtra,
    });
    return true;
  }

  private sayOrderAlert(
    row: { campaignId: string; batchNumber: number; rowNumber: number },
    ref: string,
    kind: OrderAlertKind,
    status: string,
    prefix: string,
    ctx: OrderAlertContext = {},
  ) {
    const what =
      kind !== 'NOT_APPLIED'
        ? alertKindWords(kind)
        : ctx.rowStatus === RS.CANCELLED
            ? 'the order of a CANCELLED row (order completed at Hubble after the campaign was cancelled)'
            : ctx.rowStatus === RS.BUY_FAILED
              ? "a FAILED row's CURRENT order (Hubble has news about it)"
              : "the row's CURRENT order, completed but not applied to the row";
    const tail =
      status === ALERT_LOOKUP_FAILED
        ? "couldn't check it with Hubble (the lookup failed) — check it with Hubble"
        : `Hubble status ${status}; check with Hubble (a voucher may have been issued twice, or a paid voucher may not have reached the person)`;
    this.logger.error(`[dispersal] campaign ${row.campaignId} batch ${row.batchNumber} row ${row.rowNumber}: ${prefix} ${what} (reference ${ref}) — ${tail}`);
  }

  private async orderAlertAudit(
    row: { id: string; campaignId: string; rowNumber: number; batchNumber: number },
    ref: string,
    kind: OrderAlertKind,
    status: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          actorId: null,
          action: 'UPDATE',
          entityType: 'VOUCHER_DISPERSAL_CAMPAIGN',
          entityId: row.campaignId,
          metadata: { event: SUPERSEDED_ALERT_EVENT, kind, rowId: row.id, batchNumber: row.batchNumber, rowNumber: row.rowNumber, referenceId: ref, hubbleStatus: status, ...extra },
        },
      })
      .catch((e: unknown) => this.logger.error(`[dispersal] order-alert audit failed for ${row.campaignId}: ${e}`));
  }

  /**
   * Record a lookup. For a FAILED row the row's updatedAt is kept: a lookup is not a change, and the digest
   * counts "purchase failed in the window" by updatedAt (re-review L1).
   */
  private async noteReconcile(row: Pick<Row, 'id' | 'status' | 'updatedAt'>, result: string): Promise<void> {
    await this.prisma.voucherDispersalRow
      .updateMany({
        // Restoring updatedAt is guarded on the state read earlier: a row that moved on meanwhile is never set
        // back to an older updatedAt (pre-merge L-2).
        where: { id: row.id, ...(row.status === RS.BUY_FAILED ? { status: RS.BUY_FAILED, updatedAt: row.updatedAt } : {}) },
        data: {
          lastReconcileAt: new Date(),
          lastReconcileResult: result.slice(0, 300),
          ...(row.status === RS.BUY_FAILED ? { updatedAt: row.updatedAt } : {}),
        },
      })
      .catch((e: unknown) => this.logger.warn(`[dispersal] could not record reconcile on row ${row.id}: ${e}`));
  }

  /** Apply a Hubble order body to a row (idempotent, guarded). */
  async applyBody(row: Row, body: HubbleOrderResult): Promise<ReconcileOutcome> {
    const status = String(body.status ?? '').toUpperCase();
    const hubbleOrderId = (body.id ?? body.orderId ?? null) as string | null;
    if (status === 'SUCCESS') {
      // Product-aware: Amazon Pay's claim code arrives as cardPin — send that alone (hubble-voucher.ts).
      const { code, pin, claimCodeMissing } = hubbleVoucherCredentials((body.vouchers ?? [])[0], row.productId);
      if (!code) {
        await this.markPending(row, 'HUBBLE_SUCCESS_NO_CODE', { hubbleOrderId });
        return 'PENDING';
      }
      const validTill = (body.vouchers ?? [])[0]?.validTill ?? null;
      const boughtData = {
        status: RS.BOUGHT,
        voucherCode: code,
        voucherPin: pin,
        voucherValidTill: validTill ? String(validTill).slice(0, 40) : null,
        hubbleOrderId,
        boughtAt: new Date(),
        placeResponded: true,
        claimToken: null,
        pendingReason: null,
        buyFailureReason: null,
        buyFailureSource: null,
      };
      const base = { id: row.id, hubbleReferenceId: row.hubbleReferenceId, voucherCode: null };
      // BUY_FAILED is accepted too: Hubble now HOLDS a paid voucher for the row's CURRENT reference (e.g. a FAILED
      // that later succeeded) — deliver it rather than strand it. Never overwrites a code. The FROM-FAILED write is
      // its own guarded update, so the late event fires exactly once, decided by the database — never by a stale
      // snapshot (re-review M2).
      // "Completed later" (owner/coordinator meaning, 2026-11-18) = Hubble BOUGHT a row that had FAILED: the row is
      // still BUY_FAILED, or went failed → PENDING_RECONCILE earlier (that flip keeps buyFailureSource; a normal
      // pending row has none). Marked once (lateCompletedAt IS NULL).
      // F6: one guarded write per possible previous state, in order — the one that matches tells the REAL previous
      // status (and whether this is a late completion), decided by the database, never by the snapshot.
      const attempts: { where: Prisma.VoucherDispersalRowWhereInput; from: RS; late: boolean }[] = [
        { where: { status: RS.BUY_FAILED, lateCompletedAt: null, AND: [NOT_MARKED] }, from: RS.BUY_FAILED, late: true },
        { where: { status: RS.PENDING_RECONCILE, buyFailureSource: { not: null }, lateCompletedAt: null }, from: RS.PENDING_RECONCILE, late: true },
        { where: { status: RS.BUYING }, from: RS.BUYING, late: false },
        { where: { status: RS.PENDING_RECONCILE }, from: RS.PENDING_RECONCILE, late: false },
        { where: { status: RS.BUY_FAILED, AND: [NOT_MARKED] }, from: RS.BUY_FAILED, late: false },
      ];
      let won = { count: 0 };
      let fromStatus: RS | null = null;
      let late = false;
      for (const a of attempts) {
        won = await this.prisma.voucherDispersalRow.updateMany({
          where: { ...base, ...a.where },
          data: a.late ? { ...boughtData, lateCompletedAt: new Date() } : boughtData,
        });
        if (won.count === 1) {
          fromStatus = a.from;
          late = a.late;
          break;
        }
      }
      if (won.count === 0) {
        const now = await this.prisma.voucherDispersalRow.findFirst({
          where: { id: row.id },
          select: { status: true, hubbleReferenceId: true, rowNumber: true, campaignId: true, batchNumber: true, buyFailureSource: true },
        });
        if (now?.status === RS.BOUGHT && now.hubbleReferenceId === row.hubbleReferenceId) return 'BOUGHT';
        if (now && now.hubbleReferenceId === row.hubbleReferenceId && (now.status === RS.QUEUED || now.status === RS.BUYING)) {
          // Re-queued with the SAME reference (review of 4d8454ad, L4): the next buy / lookup of that reference finds
          // this order at Hubble and applies it — not an alert.
          this.logger.warn(`[dispersal] Hubble SUCCESS for reference ${row.hubbleReferenceId} arrived while the row is ${now.status} with the same reference — it is applied by that step`);
          return 'SKIPPED';
        }
        // Hubble holds a PAID voucher for a reference this row no longer uses (superseded) or for a row we
        // could not store it on — possible second voucher / stranded money. Never silent: an error log on EVERY report,
        // and the campaign-level alert (counted on the page + in the digest; one per reference), whose audit row carries
        // the order facts. VD follow-up 2026-11-19: no second, row-level audit of the same event any more — it was
        // written again on every repeat of the same SUCCESS (the duplicate alert entry; the alert itself was deduped).
        this.logger.error(
          `[dispersal] Hubble SUCCESS for reference ${row.hubbleReferenceId} not applied (campaign ${now?.campaignId} row ${now?.rowNumber}, row status ${now?.status}, current reference ${now?.hubbleReferenceId === row.hubbleReferenceId ? 'same' : 'different'}) — ops review`,
        );
        if (!row.hubbleReferenceId) {
          // Defensive: no reference = no alert key; keep a row-level audit so it is never silent.
          await this.audit(row.id, 'VOUCHER_DISPERSAL_SUPERSEDED_REFERENCE_ACTIVITY', { referenceId: null, hubbleStatus: 'SUCCESS', hubbleOrderId, rowStatus: now?.status ?? null });
        }
        if (row.hubbleReferenceId) {
          await this.recordOrderAlert(
            { id: row.id, campaignId: row.campaignId, batchNumber: now?.batchNumber ?? row.batchNumber, rowNumber: now?.rowNumber ?? row.rowNumber },
            row.hubbleReferenceId,
            'SUCCESS',
            now && now.hubbleReferenceId !== row.hubbleReferenceId
              ? 'SUPERSEDED'
              : now?.buyFailureSource === 'MARKED_NOT_BOUGHT'
                ? 'MARKED_NOT_BOUGHT'
                : 'NOT_APPLIED',
            {
              auditExtra: {
                hubbleOrderId,
                rowStatus: now?.status ?? null,
                referenceSuperseded: now ? now.hubbleReferenceId !== row.hubbleReferenceId : null,
              },
            },
          );
        }
        return 'SKIPPED';
      }
      this.logger.log(`[dispersal] row ${row.id} voucher bought`);
      if (late) await this.lateFromFailed(row, RS.BOUGHT, hubbleOrderId);
      await this.audit(row.id, 'VOUCHER_DISPERSAL_BOUGHT', {
        hubbleOrderId,
        voucherCode: maskVoucherCodeForAudit(code),
        ...(pin ? { voucherPin: '••••' } : {}),
        fromStatus,
        ...(claimCodeMissing ? { claimCodeMissing: true } : {}),
      });
      if (claimCodeMissing) {
        // Never silent: the claim-code product (e.g. Amazon Pay) came back with no claim code, so the
        // card number was stored/sent instead — it may be unusable. Ops must check with Hubble.
        this.logger.error(
          `[dispersal] campaign ${row.campaignId} row ${row.rowNumber}: Hubble returned NO claim code (cardPin) for claim-code product ${row.productId} — card number sent instead; ops: verify with Hubble`,
        );
        await this.audit(row.id, 'VOUCHER_DISPERSAL_CLAIM_CODE_MISSING', { hubbleOrderId, productId: row.productId });
      }
      return 'BOUGHT';
    }
    if (status === 'PROCESSING') {
      await this.markPending(row, 'HUBBLE_PROCESSING', { hubbleOrderId, placeResponded: true });
      return 'PENDING';
    }
    if (status === 'FAILED') {
      const source = 'HUBBLE_FAILED';
      const reason = (body.failureReason ?? 'Hubble reported FAILED').toString().slice(0, 300);
      // From: in flight, or a local failure. A row already failed by Hubble, or released, is left as it is.
      const fromFailedSources = LOCAL_FAILURE_SOURCES;
      if (row.status === RS.BUY_FAILED && !fromFailedSources.includes(row.buyFailureSource ?? '')) return 'UNCHANGED';
      const res = await this.prisma.voucherDispersalRow.updateMany({
        where: {
          id: row.id,
          hubbleReferenceId: row.hubbleReferenceId,
          voucherCode: null,
          OR: [
            { status: { in: [RS.BUYING, RS.PENDING_RECONCILE] } },
            { status: RS.BUY_FAILED, buyFailureSource: { in: fromFailedSources } },
          ],
        },
        data: {
          status: RS.BUY_FAILED,
          buyFailureSource: source,
          buyFailureReason: reason,
          hubbleOrderId,
          placeResponded: true,
          claimToken: null,
          pendingReason: null,
        },
      });
      if (res.count === 1) {
        await this.audit(row.id, 'VOUCHER_DISPERSAL_BUY_FAILED', { source, reason, hubbleOrderId });
        return 'BUY_FAILED';
      }
      return 'SKIPPED';
    }
    if (row.status === RS.BUY_FAILED) {
      // An answer we do not understand never RELEASES or buys a row (anomaly once; "Mark as not bought" offered).
      await this.recordUnrecognisedStatus(row, status, hubbleOrderId);
      // A REJECTED row was released (canary said "no order") — but Hubble now HAS an order for it: reserve the
      // budget again (back to pending, checked automatically). Other failed rows already count — left as they are.
      if (row.buyFailureSource === 'REJECTED') {
        await this.markPending(row, `HUBBLE_UNKNOWN_STATUS:${status || '(none)'}`.slice(0, 80), { hubbleOrderId });
        return 'PENDING';
      }
      return 'UNCHANGED';
    }
    await this.markPending(row, `HUBBLE_UNKNOWN_STATUS:${status || '(none)'}`.slice(0, 80), { hubbleOrderId });
    return 'PENDING';
  }

  /**
   * An unrecognised Hubble status: error log + anomaly audit ONCE per status (pre-merge M-2 — compared with the
   * row's previous lookup result), and the lookup result is recorded (so "Mark as not bought" is offered).
   */
  async recordUnrecognisedStatus(row: Row, status: string, hubbleOrderId: string | null): Promise<void> {
    const result = `HUBBLE_${status || 'UNKNOWN'}`;
    if (row.lastReconcileResult === result) return;
    this.logger.error(
      `[dispersal] campaign ${row.campaignId} batch ${row.batchNumber} row ${row.rowNumber}: unrecognised Hubble status "${status || '(none)'}" (row ${row.status}) — left as it is; ops review`,
    );
    await this.audit(row.id, 'VOUCHER_DISPERSAL_UNKNOWN_STATUS_ON_FAILED_ROW', {
      campaignId: row.campaignId,
      batchNumber: row.batchNumber,
      rowNumber: row.rowNumber,
      rowStatus: row.status,
      hubbleStatus: status || null,
      hubbleOrderId,
      failureSource: row.buyFailureSource,
    });
    await this.noteReconcile(row, result);
  }

  /** BUYING/PENDING → PENDING_RECONCILE with a reason (first entry audited). Never throws. */
  private async markPending(row: Row, reason: string, extra: { hubbleOrderId?: string | null; placeResponded?: boolean } = {}): Promise<void> {
    try {
      // Guarded on the row's CURRENT reference (a row re-queued with a new reference is never touched by
      // a stale call) and no code. BUY_FAILED is included: when Hubble later reports the SAME reference as
      // PROCESSING / unknown, the row must go back under reconcile — never stay "failed" and get re-bought.
      const base = { id: row.id, hubbleReferenceId: row.hubbleReferenceId, voucherCode: null };
      const data = {
        status: RS.PENDING_RECONCILE,
        pendingReason: reason,
        pendingSince: row.status === RS.PENDING_RECONCILE && row.pendingSince ? row.pendingSince : new Date(),
        claimToken: null,
        ...(extra.hubbleOrderId ? { hubbleOrderId: extra.hubbleOrderId } : {}),
        ...(extra.placeResponded ? { placeResponded: true } : {}),
      };
      // From FAILED as its own guarded write: the late event fires exactly once (re-review M2).
      const fromFailed = await this.prisma.voucherDispersalRow.updateMany({
        where: { ...base, status: RS.BUY_FAILED, AND: [NOT_MARKED] }, // a marked row is closed (review M1)
        data, // buyFailureSource is KEPT: a later BOUGHT is then recognised as "bought after it had failed"
      });
      const res =
        fromFailed.count === 1
          ? fromFailed
          : await this.prisma.voucherDispersalRow.updateMany({ where: { ...base, status: { in: [RS.BUYING, RS.PENDING_RECONCILE] } }, data });
      if (res.count === 1 && (row.status !== RS.PENDING_RECONCILE || row.pendingReason !== reason)) {
        await this.audit(row.id, 'VOUCHER_DISPERSAL_PENDING', { reason });
      }
      if (fromFailed.count === 1) await this.failedBackToPending(row, reason, extra.hubbleOrderId ?? null);
      if (res.count === 0 && row.status === RS.BUY_FAILED && row.hubbleReferenceId) {
        const now = await this.prisma.voucherDispersalRow.findFirst({ where: { id: row.id }, select: { buyFailureSource: true, hubbleReferenceId: true } });
        if (now?.buyFailureSource === 'MARKED_NOT_BOUGHT' && now.hubbleReferenceId === row.hubbleReferenceId) {
          const st = reason.startsWith('HUBBLE_UNKNOWN_STATUS:') ? reason.slice('HUBBLE_UNKNOWN_STATUS:'.length) : reason === 'HUBBLE_PROCESSING' ? 'PROCESSING' : reason === 'HUBBLE_SUCCESS_NO_CODE' ? 'SUCCESS' : reason;
          // Raw Hubble text never collides with our `__` labels (M2).
          await this.recordOrderAlert(row, row.hubbleReferenceId, hubbleAlertStatus(st), 'MARKED_NOT_BOUGHT');
        }
      }
    } catch (e) {
      // Left BUYING → the stale sweep moves it to PENDING_RECONCILE (lookup only). Never re-placed.
      this.logger.error(`[dispersal] could not mark row ${row.id} pending (${reason}); the stale sweep will: ${e}`);
    }
  }

  // ─── 3. Buy ───────────────────────────────────────────────────────────────────

  async buyQueued(
    campaignId: string | undefined,
    deadline: number,
    maxBuys: number,
  ): Promise<{ bought: number; pending: number; failed: number; messagesSent: number }> {
    const out = { bought: 0, pending: 0, failed: 0, messagesSent: 0 };
    if (!this.hubble.isConfigured()) {
      const waiting = await this.prisma.voucherDispersalRow.count({ where: { status: RS.QUEUED, ...(campaignId ? { campaignId } : {}) } });
      if (waiting > 0) this.logger.error(`[dispersal] ${waiting} queued row(s) waiting but Hubble is NOT configured in this environment — nothing bought`);
      return out;
    }
    const campaigns = await this.prisma.voucherDispersalCampaign.findMany({
      where: { status: CS.PROCESSING, ...(campaignId ? { id: campaignId } : {}) },
      select: { id: true },
      orderBy: { confirmedAt: 'asc' },
    });
    if (campaigns.length === 0) return out;
    const rows = await this.prisma.voucherDispersalRow.findMany({
      where: { status: RS.QUEUED, campaignId: { in: campaigns.map((c) => c.id) } },
      // Batch, then the file's row order ("Add more people" batches restart at Excel row 2).
      orderBy: [{ campaignId: 'asc' }, { batchNumber: 'asc' }, { rowNumber: 'asc' }],
      take: maxBuys,
    });
    let first = true;
    for (const row of rows) {
      if (Date.now() > deadline) break;
      if (!first) await this.sleep(BUY_GAP_MS);
      first = false;
      const r = await this.buyRow(row);
      if (r === 'BOUGHT') {
        out.bought++;
        if (await this.sendMessage(row.id)) out.messagesSent++;
      } else if (r === 'PENDING' || r === 'NO_ORDER' || r === 'LOOKUP_FAILED') out.pending++;
      else if (r === 'BUY_FAILED') out.failed++;
    }
    return out;
  }

  /**
   * Claim a QUEUED row under the campaign row lock (budget re-check), then place ONE Hubble order with
   * the row's stored reference and apply the outcome. Never throws.
   */
  async buyRow(row: Row): Promise<ReconcileOutcome | 'BUDGET' | 'LOST'> {
    const token = randomUUID();
    let claim: 'CLAIMED' | 'LOST' | 'BUDGET';
    try {
      claim = await this.prisma.$transaction(async (tx) => {
        // Row-lock the campaign (the same lock confirm / cancel take) — serialises budget decisions.
        const camp = await tx.voucherDispersalCampaign.update({
          where: { id: row.campaignId },
          data: { updatedAt: new Date() },
          select: { status: true, budgetPaise: true },
        });
        if (camp.status !== CS.PROCESSING) return 'LOST' as const;
        const agg = await tx.voucherDispersalRow.aggregate({
          where: budgetCommittedWhere(row.campaignId),
          _sum: { amountPaise: true },
        });
        const committed = BigInt(agg._sum.amountPaise ?? 0n);
        const amount = BigInt(row.amountPaise ?? 0n);
        if (amount <= 0n || committed + amount > BigInt(camp.budgetPaise)) {
          const f = await tx.voucherDispersalRow.updateMany({
            where: { id: row.id, status: RS.QUEUED },
            data: {
              status: RS.BUY_FAILED,
              buyFailureSource: 'BUDGET',
              buyFailureReason: `Not bought: it would take the campaign over its budget (committed ₹${Number(committed) / 100} + ₹${Number(amount) / 100} > ₹${Number(camp.budgetPaise) / 100})`,
            },
          });
          return f.count === 1 ? ('BUDGET' as const) : ('LOST' as const);
        }
        const c = await tx.voucherDispersalRow.updateMany({
          where: { id: row.id, status: RS.QUEUED, hubbleReferenceId: { not: null } },
          data: {
            status: RS.BUYING,
            claimToken: token,
            buyingAt: new Date(),
            placeAttemptAt: new Date(),
            placeResponded: false,
            hubbleAccount: this.hubble.accountFingerprint(),
            attempts: { increment: 1 },
          },
        });
        return c.count === 1 ? ('CLAIMED' as const) : ('LOST' as const);
      }, CAMPAIGN_LOCK_TX);
    } catch (e) {
      this.logger.error(`[dispersal] claim failed for row ${row.id} (left QUEUED): ${e}`);
      return 'LOST';
    }
    if (claim === 'BUDGET') {
      await this.audit(row.id, 'VOUCHER_DISPERSAL_BUY_FAILED', { source: 'BUDGET' });
      return 'BUY_FAILED';
    }
    if (claim !== 'CLAIMED') return 'LOST';

    const claimed: Row = { ...row, status: RS.BUYING, claimToken: token };
    try {
      return await this.placeClaimed(claimed);
    } catch (e) {
      this.logger.error(`[dispersal] row ${row.id}: unexpected error after claim (left for reconcile, never re-placed): ${e}`);
      await this.markPending(claimed, 'UNEXPECTED');
      return 'PENDING';
    }
  }

  private async placeClaimed(row: Row): Promise<ReconcileOutcome> {
    const paise = Number(row.amountPaise ?? 0);
    const amount = paise / 100;
    const productId = row.productId ?? '';
    const ref = row.hubbleReferenceId!;

    // Defence in depth: never send Hubble an amount it can't issue (nothing reaches Hubble → definitive).
    let notSent: string | null = null;
    if (!productId) notSent = 'No Hubble product for this brand';
    else if (paise <= 0 || paise % 100 !== 0) notSent = 'Amount is not whole rupees';
    else {
      try {
        const product = await this.hubble.getProduct(productId);
        if (!isAmountIssuable(product, amount)) notSent = `₹${amount} is not an amount ${row.brandLabel ?? 'this brand'} can issue right now`;
      } catch (e) {
        // A lookup failure never blocks (Hubble validates the order itself).
        this.logger.warn(`[dispersal] product lookup failed for ${productId} (buy proceeds; Hubble validates): ${e}`);
      }
    }
    if (notSent) {
      const res = await this.prisma.voucherDispersalRow.updateMany({
        where: { id: row.id, status: RS.BUYING, claimToken: row.claimToken },
        data: { status: RS.BUY_FAILED, buyFailureSource: 'NOT_SENT', buyFailureReason: `${notSent} (not sent to Hubble)`, claimToken: null },
      });
      if (res.count === 1) await this.audit(row.id, 'VOUCHER_DISPERSAL_BUY_FAILED', { source: 'NOT_SENT', reason: notSent });
      return 'BUY_FAILED';
    }

    // From here on Hubble may hold an order for this reference: record it BEFORE the call (a failure to
    // record aborts the place — the outer catch leaves the row pending, never re-placed blindly).
    await this.prisma.voucherDispersalRow.updateMany({
      where: { id: row.id, claimToken: row.claimToken, referenceSentAt: null },
      data: { referenceSentAt: new Date() },
    });

    let body: HubbleOrderResult | null;
    try {
      body = await this.hubble.placeOrder({
        productId,
        referenceId: ref,
        amount,
        denominationDetails: [{ denomination: amount, quantity: 1 }],
        customerDetails: null,
      });
      await this.prisma.voucherDispersalRow
        .updateMany({
          where: { id: row.id, claimToken: row.claimToken },
          data: { placeResponded: true, hubbleOrderId: (body?.id ?? body?.orderId ?? null) as string | null },
        })
        .catch((e: unknown) => this.logger.warn(`[dispersal] place evidence write failed for row ${row.id}: ${e}`));
    } catch (placeErr) {
      const rejected = placeErr instanceof HubblePlaceOrderRejectedError;
      this.logger.warn(`[dispersal] placeOrder ${rejected ? 'REJECTED' : 'failed (indeterminate)'} for row ${row.id}; recovering by reference: ${placeErr}`);
      try {
        body = await this.hubble.getOrderByReference(ref);
      } catch (recoverErr) {
        this.logger.error(`[dispersal] row ${row.id}: place + recover both failed — PENDING (never re-placed automatically): ${recoverErr}`);
        await this.markPending(row, 'HUBBLE_INDETERMINATE');
        return 'PENDING';
      }
      if (body === null && !rejected) {
        await this.markPending(row, 'HUBBLE_INDETERMINATE');
        return 'PENDING';
      }
      if (body === null) {
        // Definitive rejection + "no order" — trusted ONLY when the canary proves the lookup route answers.
        const canary = await this.verifyNotFoundCanary(ref, { maxTries: 3, budgetMs: 20_000 });
        if (!canary.ok) {
          await this.markPending(row, 'HUBBLE_REJECTED_UNVERIFIED');
          await this.audit(row.id, 'VOUCHER_DISPERSAL_NO_ORDER_UNVERIFIED', { why: canary.why.slice(0, 300) });
          return 'PENDING';
        }
        const e = placeErr as HubblePlaceOrderRejectedError;
        const reason = `Hubble rejected the order (${e.hubbleCode ?? `HTTP ${e.httpStatus}`}) — not placed`;
        const res = await this.prisma.voucherDispersalRow.updateMany({
          where: { id: row.id, status: RS.BUYING, claimToken: row.claimToken },
          data: { status: RS.BUY_FAILED, buyFailureSource: 'REJECTED', buyFailureReason: reason, claimToken: null },
        });
        if (res.count === 1) await this.audit(row.id, 'VOUCHER_DISPERSAL_BUY_FAILED', { source: 'REJECTED', reason, canaryRow: canary.canaryRef });
        return 'BUY_FAILED';
      }
    }
    return this.applyBody(row, body);
  }

  /**
   * CANARY for Hubble's "no order" (see RewardsService.verifyHubbleNotFoundCanary — same rule): look up
   * orders Hubble is KNOWN to hold on the SAME Hubble account — bought dispersal rows and delivered
   * redemption orders whose recorded account fingerprint matches the current one — through the same
   * getOrderByReference. Verified on the first that comes back as that order with SUCCESS. Fails CLOSED.
   */
  async verifyNotFoundCanary(
    excludeRef: string,
    limits: { maxTries: number; budgetMs?: number } = { maxTries: 5 },
  ): Promise<{ ok: true; canaryRef: string } | { ok: false; canaryRef: string | null; why: string }> {
    const current = this.hubble.accountFingerprint();
    if (!current) return { ok: false, canaryRef: null, why: 'Hubble not configured' };
    const deadline = limits.budgetMs ? Date.now() + limits.budgetMs : null;
    const candidates: { referenceId: string; hubbleOrderRef: string | null; at: number }[] = [];
    try {
      const rows = await this.prisma.voucherDispersalRow.findMany({
        where: { status: RS.BOUGHT, hubbleOrderId: { not: null }, hubbleAccount: { not: null }, hubbleReferenceId: { not: excludeRef } },
        orderBy: { boughtAt: 'desc' },
        take: 20,
        select: { hubbleReferenceId: true, hubbleOrderId: true, hubbleAccount: true, boughtAt: true },
      });
      for (const r of rows) {
        if (r.hubbleReferenceId && r.hubbleAccount && hubbleAccountFingerprintMatches(r.hubbleAccount, current)) {
          candidates.push({ referenceId: r.hubbleReferenceId, hubbleOrderRef: r.hubbleOrderId, at: r.boughtAt?.getTime() ?? 0 });
        }
      }
      const legacyFp = current.replace(/^([^/#]*)\/[^#]*#/, '$1#');
      const orders = await this.prisma.redemptionOrder.findMany({
        where: {
          id: { not: excludeRef },
          status: 'DELIVERED',
          deliveredAt: { not: null },
          voucherProvider: { in: ['Hubble', 'hubble', 'HUBBLE'] },
          supplierOrderRef: { not: null },
          OR: [...new Set([current, legacyFp])].map((fp) => ({ metadata: { path: ['hubbleAccount'], equals: fp } })),
        },
        orderBy: [{ deliveredAt: 'desc' }],
        take: 20,
        select: { id: true, supplierOrderRef: true, deliveredAt: true, metadata: true },
      });
      for (const o of orders) {
        const acct = (o.metadata as Record<string, unknown> | null)?.hubbleAccount;
        if (typeof acct === 'string' && hubbleAccountFingerprintMatches(acct, current) && o.supplierOrderRef?.trim()) {
          candidates.push({ referenceId: o.id, hubbleOrderRef: o.supplierOrderRef, at: o.deliveredAt?.getTime() ?? 0 });
        }
      }
    } catch (e) {
      return { ok: false, canaryRef: null, why: `canary candidate query failed: ${e}` };
    }
    candidates.sort((a, b) => b.at - a.at);
    const pick = candidates.slice(0, limits.maxTries);
    if (pick.length === 0) return { ok: false, canaryRef: null, why: 'no bought/delivered Hubble voucher on this Hubble account to verify against' };
    const fails: string[] = [];
    let last: string | null = null;
    for (const c of pick) {
      const left = deadline ? deadline - Date.now() : null;
      if (left !== null && left <= 0) {
        fails.push('time budget exhausted');
        break;
      }
      last = c.referenceId;
      const why = await checkHubbleCanaryOrder(this.hubble, { referenceId: c.referenceId, hubbleOrderRef: c.hubbleOrderRef }, left);
      if (!why) return { ok: true, canaryRef: c.referenceId };
      fails.push(`${c.referenceId}: ${why}`);
    }
    return { ok: false, canaryRef: last, why: `no canary verified — ${fails.join('; ')}` };
  }

  // ─── 4. Messages ──────────────────────────────────────────────────────────────

  async sendPendingMessages(campaignId: string | undefined, deadline: number): Promise<number> {
    const rows = await this.prisma.voucherDispersalRow.findMany({
      where: { status: RS.BOUGHT, messageClaimedAt: null, ...(campaignId ? { campaignId } : {}) },
      select: { id: true },
      take: 50,
    });
    let n = 0;
    for (const r of rows) {
      if (Date.now() > deadline) break;
      if (await this.sendMessage(r.id)) n++;
    }
    return n;
  }

  /**
   * Send the voucher by WhatsApp (`voucher_code`) to a BOUGHT row — first send only (claimed via
   * messageClaimedAt so concurrent passes never double-send). Resend uses sendMessageForce.
   * @returns true when this call sent (or attempted) the message.
   */
  async sendMessage(rowId: string): Promise<boolean> {
    const claimedAt = new Date();
    const claim = await this.prisma.voucherDispersalRow.updateMany({
      where: { id: rowId, status: RS.BOUGHT, messageClaimedAt: null, voucherCode: { not: null } },
      data: { messageClaimedAt: claimedAt },
    });
    if (claim.count !== 1) return false;
    await this.deliver(rowId, claimedAt);
    return true;
  }

  /**
   * Perform the WhatsApp send for a row whose message claim (`claimedAt`) the caller holds, and record
   * the outcome (receipt id / sent time / failure) ONLY while that claim is still the row's current one —
   * a newer claim (resend) or the stale sweep is never overwritten. Returns the outcome. Never throws.
   */
  async deliver(rowId: string, claimedAt: Date): Promise<{ receiptId: string | null; error: string | null }> {
    try {
      const row = await this.prisma.voucherDispersalRow.findFirst({
        where: { id: rowId },
        include: { campaign: { select: { programLabel: true, billedToClientId: true } } },
      });
      if (!row || row.status !== RS.BOUGHT || !row.voucherCode || !row.phone) {
        return { receiptId: null, error: 'Row is not a bought voucher with a phone' };
      }
      if (!row.messageClaimedAt || row.messageClaimedAt.getTime() !== claimedAt.getTime()) {
        return { receiptId: null, error: 'Another send for this row took over' };
      }
      const code = row.voucherCode;
      const pin = row.voucherPin?.trim() || null;
      const combined = voucherCodeVar(code, pin);
      const vars: Record<string, string> = {
        ownerName: whatsappSafeVar(row.name) || 'there',
        amount: `₹${(Number(row.amountPaise ?? 0) / 100).toLocaleString('en-IN')}`,
        program: whatsappSafeVar(row.campaign.programLabel),
        voucherName: whatsappSafeVar(row.brandLabel ?? 'Gift'),
        code: combined,
      };
      const order = VARIABLE_CONTRACTS.VOUCHER_ISSUED.whatsapp;
      const res = await this.notifications.sendTrackedWhatsappTemplate({
        clientId: GIFSY_PLATFORM_CLIENT_ID,
        eventKey: DISPERSAL_EVENT_KEY,
        phone: row.phone,
        templateName: whatsappTemplateDefault(GIFSY_PLATFORM_CLIENT_ID, 'VOUCHER_ISSUED'),
        bodyValues: order.map((k) => vars[k] ?? ''),
        secretValues: pin
          ? [...new Set([combined, code, whatsappSafeVar(code), pin, whatsappSafeVar(pin)])]
          : [...new Set([code, whatsappSafeVar(code)])],
      });
      await this.prisma.voucherDispersalRow.updateMany({
        where: { id: rowId, messageClaimedAt: claimedAt },
        data: {
          whatsappReceiptId: res.receiptId,
          sentAt: res.error ? null : new Date(),
          messageError: res.error,
          messageStatus: res.error ? 'FAILED' : res.receiptId ? 'SENT' : 'SENT_UNTRACKED',
          messageDeliveredAt: null,
          messageReadAt: null,
          messageFailureReason: res.error,
        },
      });
      if (res.error) await this.audit(rowId, 'VOUCHER_DISPERSAL_MESSAGE_FAILED', { reason: res.error, receiptId: res.receiptId });
      return { receiptId: res.receiptId, error: res.error };
    } catch (e) {
      const msg = `Send could not be recorded: ${String(e).slice(0, 200)}`;
      this.logger.error(`[dispersal] message send for row ${rowId} failed: ${msg}`);
      await this.prisma.voucherDispersalRow
        .updateMany({ where: { id: rowId, messageClaimedAt: claimedAt, sentAt: null }, data: { messageError: msg, messageStatus: 'FAILED' } })
        .catch(() => undefined);
      return { receiptId: null, error: msg };
    }
  }

  /**
   * A message claim with no recorded outcome after STALE_MESSAGE_CLAIM_MS (worker died mid-send) →
   * visible "unknown — use Resend", never silent. Guarded on the claim timestamp it saw, so a send that
   * is still running under a NEWER claim is never marked. Returns the campaigns touched.
   */
  async surfaceStaleMessageClaims(campaignId?: string): Promise<string[]> {
    const rows = await this.prisma.voucherDispersalRow.findMany({
      where: {
        status: RS.BOUGHT,
        messageClaimedAt: { lt: new Date(Date.now() - STALE_MESSAGE_CLAIM_MS) },
        sentAt: null,
        messageError: null,
        whatsappReceiptId: null,
        ...(campaignId ? { campaignId } : {}),
      },
      select: { id: true, campaignId: true, messageClaimedAt: true },
      take: 200,
    });
    const touched = new Set<string>();
    for (const r of rows) {
      const res = await this.prisma.voucherDispersalRow.updateMany({
        where: { id: r.id, messageClaimedAt: r.messageClaimedAt, sentAt: null, messageError: null, whatsappReceiptId: null },
        data: { messageError: 'Send outcome unknown (the worker stopped mid-send) — use Resend', messageStatus: 'UNKNOWN' },
      });
      if (res.count === 1) touched.add(r.campaignId);
    }
    return [...touched];
  }

  /**
   * Copy receipt statuses onto the row mirror (survives the 90-day receipt retention). Guarded on the
   * receipt id it read — a resend clears/replaces the receipt id, so an OLD receipt can never overwrite
   * a newer send's state. A receipt still QUEUED (its SENT write blipped) never downgrades the row.
   * Returns the campaigns touched (their completed status is re-settled).
   */
  async mirrorMessageStatuses(campaignId?: string): Promise<string[]> {
    const rows = await this.prisma.voucherDispersalRow.findMany({
      where: {
        whatsappReceiptId: { not: null },
        OR: [{ messageStatus: null }, { messageStatus: { in: ['QUEUED', 'SENT', 'DELIVERED'] } }],
        ...(campaignId ? { campaignId } : {}),
      },
      select: { id: true, campaignId: true, whatsappReceiptId: true, messageStatus: true, messageDeliveredAt: true, messageReadAt: true },
      take: 500,
    });
    if (rows.length === 0) return [];
    const receipts = await this.prisma.messageDeliveryReceipt.findMany({
      where: { id: { in: rows.map((r) => r.whatsappReceiptId!) } },
      select: { id: true, status: true, deliveredAt: true, readAt: true, failureReason: true },
    });
    const byId = new Map(receipts.map((r) => [r.id, r]));
    const touched = new Set<string>();
    for (const row of rows) {
      const rc = byId.get(row.whatsappReceiptId!);
      if (!rc) continue;
      const st = String(rc.status);
      if (st === 'QUEUED') continue;
      if (st === row.messageStatus && (rc.deliveredAt?.getTime() ?? null) === (row.messageDeliveredAt?.getTime() ?? null) && (rc.readAt?.getTime() ?? null) === (row.messageReadAt?.getTime() ?? null)) continue;
      const res = await this.prisma.voucherDispersalRow.updateMany({
        where: { id: row.id, whatsappReceiptId: row.whatsappReceiptId },
        data: { messageStatus: st, messageDeliveredAt: rc.deliveredAt, messageReadAt: rc.readAt, messageFailureReason: rc.failureReason },
      });
      if (res.count === 1) touched.add(row.campaignId);
    }
    return [...touched];
  }

  // ─── 5. Finish ────────────────────────────────────────────────────────────────

  /** Settle every PROCESSING campaign (and the `alsoIds` touched by late message changes). */
  async finishCampaigns(campaignId?: string, alsoIds: string[] = [], deadline?: number): Promise<number> {
    const camps = await this.prisma.voucherDispersalCampaign.findMany({
      where: { status: CS.PROCESSING, ...(campaignId ? { id: campaignId } : {}) },
      select: { id: true },
      // Longest-waiting first (settle takes the row lock → updatedAt moves) so > 50 all get their turn.
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    // Re-review H1: a campaign with settle failures is retried whatever its status (a FINISHED one is never
    // picked as PROCESSING), and a FINISHED campaign with rows back in flight (its quick re-settle failed) too.
    const failing = await this.prisma.voucherDispersalCampaign.findMany({
      where: { settleFailures: { not: 0 }, ...(campaignId ? { id: campaignId } : {}) },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    const inFlightGroups = await this.prisma.voucherDispersalRow.groupBy({
      by: ['campaignId'],
      where: {
        status: { in: [RS.QUEUED, RS.BUYING, RS.PENDING_RECONCILE] },
        // PROCESSING campaigns are already selected above — keep this per-tick query to FINISHED ones.
        campaign: { status: { in: [CS.COMPLETED, CS.COMPLETED_WITH_ERRORS] } },
        ...(campaignId ? { campaignId } : {}),
      },
    });
    const reopened = inFlightGroups.length
      ? await this.prisma.voucherDispersalCampaign.findMany({
          where: { id: { in: inFlightGroups.map((g) => g.campaignId) }, status: { in: [CS.COMPLETED, CS.COMPLETED_WITH_ERRORS] } },
          select: { id: true },
          take: 50,
        })
      : [];
    const carried = [...this.carryOver];
    const ids = new Set([...carried, ...alsoIds, ...camps.map((c) => c.id), ...failing.map((c) => c.id), ...reopened.map((c) => c.id)]);
    let n = 0;
    const must = new Set([...alsoIds, ...carried]); // touched (this pass or carried over) — settled first
    let done = 0;
    for (const id of ids) {
      if (deadline !== undefined && Date.now() > deadline + SETTLE_GRACE_MS) {
        // Out of time: touched campaigns are carried to the next pass (never lost); the others are re-selected.
        if (must.has(id)) this.carryOver.add(id);
        continue;
      }
      // Past the soft deadline: touched ones + a minimum of MIN_SETTLES_PER_PASS, the rest next pass.
      if (!must.has(id) && deadline !== undefined && Date.now() > deadline && done >= MIN_SETTLES_PER_PASS) continue;
      done++;
      this.carryOver.delete(id);
      try {
        if (await this.settleCampaign(id)) n++;
        await this.prisma.voucherDispersalCampaign
          .updateMany({ where: { id, settleFailures: { not: 0 } }, data: { settleFailures: 0, settleError: null } })
          .catch((e: unknown) => this.logger.warn(`[dispersal] could not clear settle failures on ${id}: ${e}`));
      } catch (e) {
        // Logged and retried on the next pass — never blocks the other campaigns' settle. Counted: after
        // SETTLE_FAILURES_BEFORE_ALERT in a row it is surfaced (audit + settleError on the campaign views).
        this.logger.error(`[dispersal] settle failed for campaign ${id} (retried next pass): ${e}`);
        await this.noteSettleFailure(id, e);
      }
    }
    return n;
  }

  private async noteSettleFailure(id: string, e: unknown): Promise<void> {
    try {
      // ONE atomic UPDATE … RETURNING (the row lock serialises concurrent increments): each caller sees its own
      // new value, so exactly one sees the threshold crossed (old < N ≤ new) — never skipped, never doubled.
      const c = await this.prisma.$transaction(
        (tx) =>
          tx.voucherDispersalCampaign.update({
            where: { id },
            data: { settleFailures: { increment: 1 }, settleError: String((e as Error)?.message ?? e).slice(0, 300) },
            select: { settleFailures: true, settleError: true },
          }),
        WEBHOOK_SETTLE_TX, // short: never wait long on a busy campaign lock just to count a failure
      );
      const before = c.settleFailures - 1;
      if (before < SETTLE_FAILURES_BEFORE_ALERT && c.settleFailures >= SETTLE_FAILURES_BEFORE_ALERT) {
        this.logger.error(`[dispersal] campaign ${id}: status update has failed ${c.settleFailures} times in a row — ops review (${c.settleError})`);
        await this.prisma.auditLog.create({
          data: {
            actorId: null,
            action: 'UPDATE',
            entityType: 'VOUCHER_DISPERSAL_CAMPAIGN',
            entityId: id,
            metadata: { event: 'VOUCHER_DISPERSAL_SETTLE_FAILING', failures: c.settleFailures, error: c.settleError },
          },
        });
      }
    } catch (err) {
      this.logger.error(`[dispersal] could not record the settle failure of campaign ${id}: ${err}`);
    }
  }

  /**
   * Re-derive a campaign's terminal status UNDER THE CAMPAIGN ROW LOCK (the same lock retry's re-queue
   * takes, so a retry can never be stranded QUEUED on a COMPLETED campaign):
   *  - PROCESSING with nothing queued / buying / pending and every bought row messaged → COMPLETED, or
   *    COMPLETED_WITH_ERRORS when any row is BUY_FAILED or any bought row's WhatsApp is FAILED / UNKNOWN;
   *  - COMPLETED ↔ COMPLETED_WITH_ERRORS both ways as late WhatsApp statuses / resends change;
   *  - a terminal campaign that has work in flight again → back to PROCESSING.
   * Counts span EVERY batch of the campaign ("Add more people"): a confirmed batch 2 re-opens the campaign
   * (confirmBatch sets PROCESSING) and it settles again over all batches. An unconfirmed batch's rows are
   * VALID / INVALID / DUPLICATE — none of the statuses counted here — so a preview never affects the status.
   * @returns true when the status changed.
   */
  async settleCampaign(id: string, txOptions: { timeout: number; maxWait: number } = CAMPAIGN_LOCK_TX): Promise<boolean> {
    const done: CS[] = [CS.COMPLETED, CS.COMPLETED_WITH_ERRORS];
    const r = await this.prisma.$transaction(async (tx) => {
      const camp = await tx.voucherDispersalCampaign
        .update({ where: { id }, data: { updatedAt: new Date() }, select: { status: true } })
        .catch(() => null);
      if (!camp || (camp.status !== CS.PROCESSING && !done.includes(camp.status))) return null;
      const inFlight = await tx.voucherDispersalRow.count({
        where: { campaignId: id, status: { in: [RS.QUEUED, RS.BUYING, RS.PENDING_RECONCILE] } },
      });
      if (inFlight > 0) {
        if (camp.status === CS.PROCESSING) return null;
        await tx.voucherDispersalCampaign.update({ where: { id }, data: { status: CS.PROCESSING, completedAt: null } });
        return { from: camp.status, to: CS.PROCESSING, failed: 0, msgFailed: 0 };
      }
      if (camp.status === CS.PROCESSING) {
        const unsent = await tx.voucherDispersalRow.count({ where: { campaignId: id, status: RS.BOUGHT, messageClaimedAt: null } });
        if (unsent > 0) return null;
      }
      // Rows marked "not bought" are CLOSED, not errors (release-gate review).
      const failed = await tx.voucherDispersalRow.count({ where: { campaignId: id, status: RS.BUY_FAILED, AND: [NOT_MARKED] } });
      const msgFailed = await tx.voucherDispersalRow.count({
        where: { campaignId: id, status: RS.BOUGHT, messageStatus: { in: ['FAILED', 'UNKNOWN'] } },
      });
      const to = failed > 0 || msgFailed > 0 ? CS.COMPLETED_WITH_ERRORS : CS.COMPLETED;
      if (to === camp.status) return null;
      await tx.voucherDispersalCampaign.update({
        where: { id },
        data: { status: to, ...(camp.status === CS.PROCESSING ? { completedAt: new Date() } : {}) },
      });
      return { from: camp.status, to, failed, msgFailed };
    }, txOptions);
    if (!r) return false;
    await this.prisma.auditLog
      .create({
        data: {
          actorId: null,
          action: 'UPDATE',
          entityType: 'VOUCHER_DISPERSAL_CAMPAIGN',
          entityId: id,
          metadata: { event: 'VOUCHER_DISPERSAL_CAMPAIGN_STATUS', from: r.from, to: r.to, buyFailed: r.failed, messageFailed: r.msgFailed },
        },
      })
      .catch((e: unknown) => this.logger.error(`[dispersal] campaign status audit failed for ${id}: ${e}`));
    return true;
  }

  /**
   * NEVER SILENT (owner rule): a row that had FAILED (any source — REJECTED / HUBBLE_FAILED / a local failure
   * whose reference reached Hubble earlier) and that Hubble now reports bought or still processing. A REJECTED
   * one was released from the budget, so spend may now exceed it → the over-budget check runs too.
   */
  private async lateFromFailed(row: Row, to: RS, hubbleOrderId: string | null): Promise<void> {
    const amountRupees = Number(row.amountPaise ?? 0) / 100;
    this.logger.error(
      `[dispersal] campaign ${row.campaignId} batch ${row.batchNumber} row ${row.rowNumber}: a purchase that had FAILED / been refused (${row.buyFailureSource ?? '?'}) was completed LATER — bought by Hubble (₹${amountRupees}) — ops review`,
    );
    await this.audit(row.id, 'VOUCHER_DISPERSAL_FAILED_ROW_COMPLETED_LATER', {
      campaignId: row.campaignId,
      batchNumber: row.batchNumber,
      rowNumber: row.rowNumber,
      amountRupees,
      fromSource: row.buyFailureSource,
      to,
      hubbleOrderId,
    });
    await this.checkOverBudget(row.campaignId);
  }

  /**
   * A FAILED row that Hubble now reports as still processing: informational (it may yet be bought — counted then,
   * once). Logged + audited; the over-budget check runs (a REJECTED row counts again while pending).
   */
  private async failedBackToPending(row: Row, reason: string, hubbleOrderId: string | null): Promise<void> {
    const amountRupees = Number(row.amountPaise ?? 0) / 100;
    this.logger.warn(
      `[dispersal] campaign ${row.campaignId} batch ${row.batchNumber} row ${row.rowNumber}: a FAILED purchase (${row.buyFailureSource ?? '?'}) is pending again at Hubble (${reason}, ₹${amountRupees})`,
    );
    await this.audit(row.id, 'VOUCHER_DISPERSAL_FAILED_ROW_PENDING_AGAIN', {
      campaignId: row.campaignId,
      batchNumber: row.batchNumber,
      rowNumber: row.rowNumber,
      amountRupees,
      fromSource: row.buyFailureSource,
      reason,
      hubbleOrderId,
    });
    await this.checkOverBudget(row.campaignId);
  }

  /** Loud audit + error log when what can still cost money (spent + with Hubble + …) exceeds the budget. */
  async checkOverBudget(campaignId: string): Promise<void> {
    try {
      const camp = await this.prisma.voucherDispersalCampaign.findUnique({ where: { id: campaignId }, select: { budgetPaise: true } });
      if (!camp) return;
      const b = await budgetBreakdown(this.prisma, campaignId);
      const { overPaise: over, committedPaise } = overBudget(b, BigInt(camp.budgetPaise));
      if (over <= 0n) return;
      const r = (p: bigint) => Number(p) / 100;
      this.logger.error(`[dispersal] campaign ${campaignId} is OVER BUDGET by ₹${r(over)} (committed ₹${r(committedPaise)} > budget ₹${r(BigInt(camp.budgetPaise))}) — ops review`);
      await this.prisma.auditLog
        .create({
          data: {
            actorId: null,
            action: 'UPDATE',
            entityType: 'VOUCHER_DISPERSAL_CAMPAIGN',
            entityId: campaignId,
            metadata: {
              event: 'VOUCHER_DISPERSAL_OVER_BUDGET',
              budgetRupees: r(BigInt(camp.budgetPaise)),
              committedRupees: r(committedPaise),
              overByRupees: r(over),
              spentRupees: r(b.spentPaise),
            },
          },
        })
        .catch((e: unknown) => this.logger.error(`[dispersal] over-budget audit failed for ${campaignId}: ${e}`));
    } catch (e) {
      this.logger.error(`[dispersal] over-budget check failed for ${campaignId}: ${e}`);
    }
  }

  /** Re-settle one campaign after a row changed outside a drain pass (webhook / retry lookup). Never throws. */
  async resettle(campaignId: string): Promise<void> {
    try {
      await this.settleCampaign(campaignId, WEBHOOK_SETTLE_TX);
    } catch (e) {
      // Left to the next drain pass (it re-settles finished campaigns with rows back in flight). NOT a settle
      // failure: a busy campaign lock is normal here (re-review L2).
      this.logger.warn(`[dispersal] quick re-settle of ${campaignId} skipped (left to the drain): ${e}`);
    }
  }

  /**
   * Re-queue a row (manual retry) and re-open its campaign in ONE transaction under the campaign row
   * lock. Refuses a CANCELLED (or not-yet-confirmed) campaign inside the transaction.
   */
  async requeueUnderLock(
    campaignId: string,
    where: Prisma.VoucherDispersalRowWhereInput,
    data: Prisma.VoucherDispersalRowUpdateManyMutationInput,
    budget?: { rowId: string; amountPaise: bigint },
  ): Promise<'OK' | 'LOST' | 'CAMPAIGN_CLOSED' | { refused: 'BUDGET'; needPaise: bigint; leftPaise: bigint }> {
    return this.prisma.$transaction(async (tx) => {
      const camp = await tx.voucherDispersalCampaign.update({
        where: { id: campaignId },
        data: { updatedAt: new Date() },
        select: { status: true, budgetPaise: true },
      });
      const open: CS[] = [CS.PROCESSING, CS.COMPLETED, CS.COMPLETED_WITH_ERRORS];
      if (!open.includes(camp.status)) return 'CAMPAIGN_CLOSED' as const;
      if (budget) {
        // Money-audit M2: a retry must not take budget already promised to queued rows (e.g. a confirmed
        // "Add more people" batch). Everything else that can still cost money (this row excluded — it may
        // already be counted) + this row must fit, under the same lock every buy claim takes.
        const b = await budgetBreakdown(tx, campaignId, budget.rowId);
        const left = BigInt(camp.budgetPaise) - b.floorPaise;
        if (budget.amountPaise > left) return { refused: 'BUDGET' as const, needPaise: budget.amountPaise, leftPaise: left < 0n ? 0n : left };
      }
      const res = await tx.voucherDispersalRow.updateMany({ where: { ...where, campaignId, AND: [NOT_MARKED] }, data: { ...data, status: RS.QUEUED } });
      if (res.count !== 1) return 'LOST' as const;
      if (camp.status !== CS.PROCESSING) {
        await tx.voucherDispersalCampaign.update({ where: { id: campaignId }, data: { status: CS.PROCESSING, completedAt: null } });
      }
      return 'OK' as const;
    }, CAMPAIGN_LOCK_TX);
  }

  /** System audit row for a row event (codes masked by the caller — never in clear). Never throws. */
  async audit(rowId: string, event: string, metadata: Record<string, unknown>, actorId: string | null = null): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          actorId,
          action: 'UPDATE',
          entityType: 'VOUCHER_DISPERSAL_ROW',
          entityId: rowId,
          metadata: { event, ...metadata } as Prisma.InputJsonValue,
        },
      })
      .catch((e: unknown) => this.logger.error(`[dispersal] audit ${event} failed for row ${rowId}: ${e}`));
  }
}
