/**
 * HELD OPENING BALANCES — Gifsy console service (list / preview / Apply now / cancel / sweep) + digest figures.
 * Owner-approved 2026-11-21 (platform-wide mechanism, dormant unless rows exist). GIFSY_ADMIN only (controller).
 * Tenant: the assumed tenant, or an explicit clientId for an un-assumed Gifsy session (resolveEngineAdminTenant).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { HeldOpeningBalanceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../wallet.service';
import { applyHeldRow, HELD_AUDIT_ENTITY, HeldAdjust, sweepHeldOpeningBalances } from './held-balance-apply';
import { planHeldPassbook } from './held-balance-events';
import {
  HELD_STATE_LABEL,
  HeldDigestFigures,
  heldDigestFigures,
  heldNextStep,
  heldOutletFacts,
  heldRowState,
  HeldRowState,
  normOutletCode,
  walletHasActivity,
} from './held-balance-facts';

export type { HeldDigestFigures };

type Actor = { sub: string; clientId: string; role?: string; assumed?: boolean };

const STATUSES: HeldOpeningBalanceStatus[] = ['PENDING', 'APPLIED', 'FAILED', 'CANCELLED'];
const WAIT_STATES: HeldRowState[] = ['NOT_ON_PORTAL', 'AWAITING_KYC', 'WALLET_EMPTY', 'NEEDS_APPLY_NOW', 'WALLET_NOT_PREPARED', 'AMBIGUOUS_OUTLET'];

@Injectable()
export class HeldOpeningBalancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  /** Apply now onto a wallet with activity: ONE engine movement (WalletService single write-path). */
  private readonly adjust: HeldAdjust = (tx, a) =>
    this.wallet.postHeldOpeningAdjustment(tx, a.partnerId, a.points, { description: a.description, sourceId: a.sourceId, metadata: a.metadata });

  private tenant(actor: Actor, clientId?: string | null) {
    return this.wallet.resolveEngineAdminTenant(actor, clientId);
  }

  async list(
    actor: Actor,
    q: { clientId?: string; status?: string; q?: string; page?: number | string; pageSize?: number | string },
  ) {
    const clientId = await this.tenant(actor, q.clientId);
    const status = q.status && STATUSES.includes(q.status as HeldOpeningBalanceStatus) ? (q.status as HeldOpeningBalanceStatus) : undefined;
    if (q.status && !status) throw new BadRequestException(`status must be one of ${STATUSES.join(' | ')}`);
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    const search = q.q ? normOutletCode(q.q) : '';
    const where: Prisma.HeldOpeningBalanceWhereInput = {
      clientId,
      ...(status ? { status } : {}),
      ...(search ? { outletCode: { contains: search } } : {}),
    };
    const [total, rows, groups] = await Promise.all([
      this.prisma.heldOpeningBalance.count({ where }),
      this.prisma.heldOpeningBalance.findMany({
        where,
        orderBy: [{ status: 'asc' }, { outletCode: 'asc' }, { source: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.heldOpeningBalance.groupBy({ by: ['status'], where: { clientId }, _count: { _all: true }, _sum: { closingPoints: true } }),
    ]);
    const totals = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, points: 0 }])) as Record<HeldOpeningBalanceStatus, { count: number; points: number }>;
    for (const g of groups) totals[g.status] = { count: g._count._all, points: g._sum.closingPoints ?? 0 };

    // Waiting rows split by WHAT they wait for (all PENDING rows of the tenant, not just this page).
    const pendingByState = Object.fromEntries(WAIT_STATES.map((s) => [s, { count: 0, points: 0 }])) as Record<string, { count: number; points: number }>;
    const pending = await this.prisma.heldOpeningBalance.findMany({ where: { clientId, status: 'PENDING' }, select: { outletCode: true, closingPoints: true } });
    for (let i = 0; i < pending.length; i += 1000) {
      const chunk = pending.slice(i, i + 1000);
      const pf = await heldOutletFacts(this.prisma, clientId, chunk.map((p) => p.outletCode));
      for (const p of chunk) {
        const s = heldRowState('PENDING', pf.get(normOutletCode(p.outletCode)));
        pendingByState[s].count += 1;
        pendingByState[s].points += p.closingPoints;
      }
    }

    const facts = await heldOutletFacts(this.prisma, clientId, rows.map((r) => r.outletCode));
    return {
      clientId,
      total,
      page,
      pageSize,
      totals,
      pendingByState,
      rows: rows.map((r) => {
        const f = facts.get(normOutletCode(r.outletCode));
        const state = heldRowState(r.status, f);
        return {
          id: r.id,
          outletCode: r.outletCode,
          outletName: f?.name ?? null,
          outletExists: !!f,
          hasWallet: !!f?.wallet,
          walletHasActivity: f?.wallet ? walletHasActivity(f.wallet) : false,
          state,
          stateLabel: state === 'FAILED' ? `Failed — ${r.failureReason ?? 'unknown reason'}` : HELD_STATE_LABEL[state],
          nextStep: heldNextStep(state, f),
          closingPoints: r.closingPoints,
          eventCount: Array.isArray(r.events) ? r.events.length : 0,
          source: r.source,
          asOfDate: r.asOfDate,
          status: r.status,
          appliedAt: r.appliedAt,
          appliedWalletId: r.appliedWalletId,
          applyMode: r.applyMode,
          sequencing: r.sequencing,
          failureReason: r.failureReason,
          cancelReason: r.cancelReason,
          attempts: r.attempts,
          lastError: r.lastError,
          createdAt: r.createdAt,
        };
      }),
    };
  }

  private async loadRow(clientId: string, id: string) {
    // Tenant isolation: a row of another tenant is a 404, never a cross-tenant read/write.
    const row = await this.prisma.heldOpeningBalance.findFirst({ where: { id, clientId } });
    if (!row) throw new NotFoundException('Held opening balance not found for this program');
    return row;
  }

  async preview(actor: Actor, id: string, explicitClientId?: string | null) {
    const clientId = await this.tenant(actor, explicitClientId);
    const row = await this.loadRow(clientId, id);
    const f = (await heldOutletFacts(this.prisma, clientId, [row.outletCode])).get(normOutletCode(row.outletCode));
    const base = { id: row.id, outletCode: row.outletCode, closingPoints: row.closingPoints, eventCount: Array.isArray(row.events) ? row.events.length : 0 };
    const blocked = (blockedReason: string) => ({ ...base, canApply: false, blockedReason, mode: null, walletId: f?.wallet?.id ?? null, balanceBefore: f?.wallet?.redeemablePoints ?? null, balanceAfter: null });
    if (row.status !== 'PENDING' && row.status !== 'FAILED') return blocked(`This row is ${row.status} — only a waiting or failed row can be applied.`);
    if (!f) return blocked('The outlet is not on the portal yet — the balance is applied automatically when its KYC is approved.');
    if (f.ambiguous) return blocked(HELD_STATE_LABEL.AMBIGUOUS_OUTLET);
    if (!f.wallet) return blocked('The outlet has no wallet yet — the balance is applied automatically when its KYC is approved.');
    const planned = planHeldPassbook(row.outletCode, row.closingPoints, row.events, row.eventTotals ?? undefined);
    if (!planned.ok) return blocked(`The held passbook does not tie out — ${planned.reason}. Cancel it and load a corrected row.`);
    const prior = await this.prisma.heldOpeningBalance.findFirst({ where: { appliedWalletId: f.wallet.id, status: 'APPLIED', id: { not: row.id } }, select: { outletCode: true } });
    if (prior) return blocked(`This wallet already received a held opening balance (${prior.outletCode}).`);
    const active = walletHasActivity(f.wallet);
    const before = f.wallet.redeemablePoints;
    if (active && f.wallet.movementSeq === 0) {
      return blocked(HELD_STATE_LABEL.WALLET_NOT_PREPARED + ' (its history is not sequenced yet).');
    }
    if (active && row.closingPoints < 0 && before < -row.closingPoints) {
      return blocked(`The wallet holds ${before} pts — fewer than the negative opening balance (${row.closingPoints} pts). Resolve with the client first.`);
    }
    return {
      ...base,
      canApply: true,
      blockedReason: null,
      mode: active ? ('OPENING_ADJUSTMENT' as const) : ('FULL_PASSBOOK' as const),
      walletId: f.wallet.id,
      balanceBefore: before,
      balanceAfter: before + row.closingPoints,
    };
  }

  /** POST :id/apply — explicit, audited Gifsy action. Returns FAILED (with the reason) rather than throwing for a held-balance problem. */
  async applyNow(actor: Actor, id: string, explicitClientId?: string | null, reason?: string | null) {
    const clientId = await this.tenant(actor, explicitClientId);
    const row = await this.loadRow(clientId, id);
    if (row.status !== 'PENDING' && row.status !== 'FAILED') {
      throw new ConflictException(`This held opening balance is ${row.status} — nothing was changed.`);
    }
    const r = await applyHeldRow(this.prisma, row.id, { trigger: 'MANUAL', actorId: actor.sub, allowedFrom: ['PENDING', 'FAILED'], adjust: this.adjust, note: reason?.trim() || null });
    if (r.status === 'NO_WALLET') throw new ConflictException(`Nothing was changed: ${r.reason} — it is applied automatically at KYC approval.`);
    if (r.status === 'SKIPPED') throw new ConflictException(`Nothing was changed: ${r.reason}.`);
    if (r.status === 'NOT_PREPARED') throw new ConflictException(`Nothing was changed: ${HELD_STATE_LABEL.WALLET_NOT_PREPARED}.`);
    const after = await this.prisma.heldOpeningBalance.findUnique({ where: { id } });
    return {
      id,
      status: after?.status ?? r.status,
      appliedAt: after?.appliedAt ?? null,
      applyMode: after?.applyMode ?? null,
      balanceBefore: r.balanceBefore ?? null,
      balanceAfter: r.balanceAfter ?? null,
      failureReason: after?.status === 'FAILED' ? after.failureReason : r.status === 'RETRYING' ? `Temporary error — ${r.reason} (try again)` : null,
    };
  }

  /** POST :id/cancel — audited; reason required. PENDING / FAILED only. */
  async cancel(actor: Actor, id: string, explicitClientId: string | null | undefined, reason: string | null | undefined) {
    const clientId = await this.tenant(actor, explicitClientId);
    const why = reason?.trim();
    if (!why) throw new BadRequestException('A reason is required to cancel a held opening balance — nothing was changed.');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.heldOpeningBalance.findFirst({ where: { id, clientId } });
      if (!row) throw new NotFoundException('Held opening balance not found for this program');
      const u = await tx.heldOpeningBalance.updateMany({
        where: { id, clientId, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actor.sub, cancelReason: why },
      });
      if (u.count !== 1) throw new ConflictException(`This held opening balance is ${row.status} — only a waiting or failed row can be cancelled. Nothing was changed.`);
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: HELD_AUDIT_ENTITY,
          entityId: id,
          actorId: actor.sub,
          oldValues: { status: row.status } as Prisma.InputJsonValue,
          newValues: { status: 'CANCELLED', cancelReason: why } as Prisma.InputJsonValue,
          metadata: { clientId, outletCode: row.outletCode, closingPoints: row.closingPoints, source: row.source } as Prisma.InputJsonValue,
        },
      });
      return tx.heldOpeningBalance.findFirstOrThrow({ where: { id, clientId } });
    });
  }

  /** POST sweep — run the automatic sweep now (all tenants; the same as the periodic worker). */
  async sweepNow() {
    const out = await sweepHeldOpeningBalances(this.prisma);
    const count = (s: string) => out.filter((o) => o.status === s).length;
    return { processed: out.length, applied: count('APPLIED'), failed: count('FAILED'), retrying: count('RETRYING') };
  }

  /** Daily Ops Digest figures for one tenant (null when the tenant has no held rows → section hidden). */
  digestFigures(clientId: string, window: { startMs: number; endMs: number; label?: string }): Promise<HeldDigestFigures | null> {
    return heldDigestFigures(this.prisma, clientId, window);
  }
}
