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
 * A BUY_FAILED row Hubble may still complete: its CURRENT reference reached Hubble, and the failure is NOT a
 * `REJECTED` one (Hubble refused the order AND the canary verified "no order" — owner decision 2026-11-18:
 * released from the budget). `HUBBLE_FAILED` (Hubble's own FAILED body) keeps counting: `applyBody` still
 * delivers a later SUCCESS for it. OR-wrapped so a NULL source is never dropped by `not`.
 */
export const failedMayStillCompleteWhere: Prisma.VoucherDispersalRowWhereInput = {
  status: RS.BUY_FAILED,
  referenceSentAt: { not: null },
  OR: [{ buyFailureSource: null }, { buyFailureSource: { not: 'REJECTED' } }],
};

/**
 * Options for every transaction that takes the campaign row lock (edit, confirm, batch upload / confirm /
 * discard, cancel, buy claim, retry re-queue, settle). One budget so a lock held by the longest of them
 * (a batch insert) never times the others out at Prisma's 5 s default (P2028).
 */
export const CAMPAIGN_LOCK_TX = { timeout: 30_000, maxWait: 25_000 } as const;
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
  | 'SKIPPED';

@Injectable()
export class VoucherDispersalProcessor {
  private readonly logger = new Logger(VoucherDispersalProcessor.name);
  private running = false;
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
      s.reconciled = await this.step('reconcile', () => this.reconcilePending(opts.campaignId, deadline), 0);
      s.messagesSent += await this.step('messages', () => this.sendPendingMessages(opts.campaignId, deadline), 0);
      const touched = new Set<string>();
      const staleMsg = await this.step('stale-messages', () => this.surfaceStaleMessageClaims(opts.campaignId), [] as string[]);
      staleMsg.forEach((id) => touched.add(id));
      const buys = await this.step('buy', () => this.buyQueued(opts.campaignId, deadline, opts.maxBuys ?? 50), null);
      if (buys) {
        s.bought = buys.bought;
        s.pending = buys.pending;
        s.failed = buys.failed;
        s.messagesSent += buys.messagesSent;
      }
      const mirrored = await this.step('mirror', () => this.mirrorMessageStatuses(opts.campaignId), [] as string[]);
      mirrored.forEach((id) => touched.add(id));
      s.campaignsFinished = await this.step('finish', () => this.finishCampaigns(opts.campaignId, [...touched]), 0);
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

  async reconcilePending(campaignId: string | undefined, deadline: number): Promise<number> {
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
    let n = 0;
    for (const row of rows) {
      if (Date.now() > deadline) break;
      await this.reconcileRow(row);
      n++;
    }
    return n;
  }

  /**
   * Look the row's CURRENT reference up at Hubble and apply what Hubble says. Never places an order.
   * "No order" is only recorded (never fails the row) — a manual retry decides, under the 2 h + canary rule.
   */
  async reconcileRow(row: Row): Promise<ReconcileOutcome> {
    if (!this.hubble.isConfigured()) return 'NOT_CONFIGURED';
    if (!row.hubbleReferenceId) return 'SKIPPED';
    let body: HubbleOrderResult | null;
    try {
      body = await this.hubble.getOrderByReference(row.hubbleReferenceId);
    } catch (e) {
      await this.noteReconcile(row.id, `LOOKUP_FAILED: ${String(e).slice(0, 200)}`);
      return 'LOOKUP_FAILED';
    }
    if (body === null) {
      await this.noteReconcile(row.id, 'NO_ORDER_AT_HUBBLE_YET');
      return 'NO_ORDER';
    }
    await this.noteReconcile(row.id, `HUBBLE_${String(body.status ?? '').toUpperCase() || 'UNKNOWN'}`);
    return this.applyBody(row, body);
  }

  /** Webhook entry: find the row by reference and reconcile it. NOT_FOUND when no dispersal row owns it. */
  async reconcileByReference(referenceId: string): Promise<ReconcileOutcome> {
    const row = await this.prisma.voucherDispersalRow.findFirst({ where: { hubbleReferenceId: referenceId } });
    if (row) {
      if (row.status !== RS.BUYING && row.status !== RS.PENDING_RECONCILE && row.status !== RS.BUY_FAILED) {
        return 'SKIPPED';
      }
      // BUYING: the in-flight call will apply the body itself; a lookup now is harmless (guarded) but
      // would double the Hubble traffic — let the pass that owns the claim finish.
      if (row.status === RS.BUYING) return 'SKIPPED';
      const outcome = await this.reconcileRow(row);
      if (outcome === 'BOUGHT') await this.sendMessage(row.id);
      return outcome;
    }
    const superseded = await this.prisma.voucherDispersalRow.findFirst({
      where: { previousReferenceIds: { has: referenceId } },
      select: { id: true, campaignId: true, rowNumber: true },
    });
    if (!superseded) return 'NOT_FOUND';
    // A webhook for a reference we retired after Hubble DEFINITIVELY failed it. If Hubble now reports it
    // SUCCESS, the recipient may hold two vouchers — never silent: loud log + audit for ops.
    let status = 'UNKNOWN';
    try {
      const b = await this.hubble.getOrderByReference(referenceId);
      status = b === null ? 'NO_ORDER' : String(b.status ?? '').toUpperCase();
    } catch (e) {
      status = `LOOKUP_FAILED`;
    }
    if (status === 'SUCCESS' || status === 'PROCESSING' || status === 'LOOKUP_FAILED') {
      this.logger.error(
        `[dispersal] webhook for SUPERSEDED reference on campaign ${superseded.campaignId} row ${superseded.rowNumber}: Hubble status ${status} — possible second voucher; ops review`,
      );
      await this.audit(superseded.id, 'VOUCHER_DISPERSAL_SUPERSEDED_REFERENCE_ACTIVITY', { referenceId, hubbleStatus: status });
    }
    return 'SKIPPED';
  }

  private async noteReconcile(rowId: string, result: string): Promise<void> {
    await this.prisma.voucherDispersalRow
      .updateMany({ where: { id: rowId }, data: { lastReconcileAt: new Date(), lastReconcileResult: result.slice(0, 300) } })
      .catch((e: unknown) => this.logger.warn(`[dispersal] could not record reconcile on row ${rowId}: ${e}`));
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
      // BUY_FAILED is accepted here too: Hubble now HOLDS a paid voucher for the row's CURRENT reference
      // (e.g. a FAILED that later succeeded) — deliver it rather than strand it. Never overwrites a code.
      const won = await this.prisma.voucherDispersalRow.updateMany({
        where: {
          id: row.id,
          hubbleReferenceId: row.hubbleReferenceId,
          status: { in: [RS.BUYING, RS.PENDING_RECONCILE, RS.BUY_FAILED] },
          voucherCode: null,
        },
        data: {
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
        },
      });
      if (won.count === 0) {
        const now = await this.prisma.voucherDispersalRow.findFirst({
          where: { id: row.id },
          select: { status: true, hubbleReferenceId: true, rowNumber: true, campaignId: true },
        });
        if (now?.status === RS.BOUGHT && now.hubbleReferenceId === row.hubbleReferenceId) return 'BOUGHT';
        // Hubble holds a PAID voucher for a reference this row no longer uses (superseded) or for a row we
        // could not store it on — possible second voucher / stranded money. Never silent.
        this.logger.error(
          `[dispersal] Hubble SUCCESS for reference ${row.hubbleReferenceId} not applied (campaign ${now?.campaignId} row ${now?.rowNumber}, row status ${now?.status}, current reference ${now?.hubbleReferenceId === row.hubbleReferenceId ? 'same' : 'different'}) — ops review`,
        );
        await this.audit(row.id, 'VOUCHER_DISPERSAL_SUPERSEDED_REFERENCE_ACTIVITY', {
          referenceId: row.hubbleReferenceId,
          hubbleStatus: 'SUCCESS',
          hubbleOrderId,
          rowStatus: now?.status ?? null,
          referenceSuperseded: now ? now.hubbleReferenceId !== row.hubbleReferenceId : null,
        });
        return 'SKIPPED';
      }
      this.logger.log(`[dispersal] row ${row.id} voucher bought`);
      await this.audit(row.id, 'VOUCHER_DISPERSAL_BOUGHT', {
        hubbleOrderId,
        voucherCode: maskVoucherCodeForAudit(code),
        ...(pin ? { voucherPin: '••••' } : {}),
        fromStatus: row.status,
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
      const reason = (body.failureReason ?? 'Hubble reported FAILED').toString().slice(0, 300);
      const alreadyHubbleFailed = row.status === RS.BUY_FAILED && !LOCAL_FAILURE_SOURCES.includes(row.buyFailureSource ?? '');
      if (alreadyHubbleFailed) return 'BUY_FAILED';
      const res = await this.prisma.voucherDispersalRow.updateMany({
        where: {
          id: row.id,
          hubbleReferenceId: row.hubbleReferenceId,
          voucherCode: null,
          OR: [
            { status: { in: [RS.BUYING, RS.PENDING_RECONCILE] } },
            { status: RS.BUY_FAILED, buyFailureSource: { in: LOCAL_FAILURE_SOURCES } },
          ],
        },
        data: {
          status: RS.BUY_FAILED,
          buyFailureSource: 'HUBBLE_FAILED',
          buyFailureReason: reason,
          hubbleOrderId,
          placeResponded: true,
          claimToken: null,
          pendingReason: null,
        },
      });
      if (res.count === 1) {
        await this.audit(row.id, 'VOUCHER_DISPERSAL_BUY_FAILED', { source: 'HUBBLE_FAILED', reason, hubbleOrderId });
        return 'BUY_FAILED';
      }
      return 'SKIPPED';
    }
    await this.markPending(row, `HUBBLE_UNKNOWN_STATUS:${status || '(none)'}`.slice(0, 80), { hubbleOrderId });
    return 'PENDING';
  }

  /** BUYING/PENDING → PENDING_RECONCILE with a reason (first entry audited). Never throws. */
  private async markPending(row: Row, reason: string, extra: { hubbleOrderId?: string | null; placeResponded?: boolean } = {}): Promise<void> {
    try {
      // Guarded on the row's CURRENT reference (a row re-queued with a new reference is never touched by
      // a stale call) and no code. BUY_FAILED is included: when Hubble later reports the SAME reference as
      // PROCESSING / unknown, the row must go back under reconcile — never stay "failed" and get re-bought.
      const res = await this.prisma.voucherDispersalRow.updateMany({
        where: {
          id: row.id,
          hubbleReferenceId: row.hubbleReferenceId,
          voucherCode: null,
          status: { in: [RS.BUYING, RS.PENDING_RECONCILE, RS.BUY_FAILED] },
        },
        data: {
          status: RS.PENDING_RECONCILE,
          pendingReason: reason,
          pendingSince: row.status === RS.PENDING_RECONCILE && row.pendingSince ? row.pendingSince : new Date(),
          claimToken: null,
          ...(extra.hubbleOrderId ? { hubbleOrderId: extra.hubbleOrderId } : {}),
          ...(extra.placeResponded ? { placeResponded: true } : {}),
        },
      });
      if (res.count === 1 && (row.status !== RS.PENDING_RECONCILE || row.pendingReason !== reason)) {
        await this.audit(row.id, 'VOUCHER_DISPERSAL_PENDING', { reason });
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
  async finishCampaigns(campaignId?: string, alsoIds: string[] = []): Promise<number> {
    const camps = await this.prisma.voucherDispersalCampaign.findMany({
      where: { status: CS.PROCESSING, ...(campaignId ? { id: campaignId } : {}) },
      select: { id: true },
      take: 50,
    });
    const ids = new Set([...camps.map((c) => c.id), ...alsoIds]);
    let n = 0;
    for (const id of ids) {
      try {
        if (await this.settleCampaign(id)) n++;
      } catch (e) {
        // Logged and retried on the next pass — never blocks the other campaigns' settle.
        this.logger.error(`[dispersal] settle failed for campaign ${id} (retried next pass): ${e}`);
      }
    }
    return n;
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
  async settleCampaign(id: string): Promise<boolean> {
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
      const failed = await tx.voucherDispersalRow.count({ where: { campaignId: id, status: RS.BUY_FAILED } });
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
    }, CAMPAIGN_LOCK_TX);
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
      const res = await tx.voucherDispersalRow.updateMany({ where: { ...where, campaignId }, data: { ...data, status: RS.QUEUED } });
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
