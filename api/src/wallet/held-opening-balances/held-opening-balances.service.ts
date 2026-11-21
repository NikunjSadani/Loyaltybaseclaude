/**
 * HELD OPENING BALANCES — Gifsy console service (list / preview / Apply now / cancel) + the Daily Ops Digest figures.
 * Owner-approved 2026-11-21 (platform-wide mechanism, dormant unless rows exist). GIFSY_ADMIN only (controller).
 * Tenant: the assumed tenant, or an explicit clientId for an un-assumed Gifsy session (resolveEngineAdminTenant).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { HeldOpeningBalanceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { WalletService } from '../wallet.service';
import {
  applyHeldRowToPristineWallet,
  HELD_AUDIT_ENTITY,
  HeldApplyOutcome,
  markHeldFailed,
  ReadEngineMode,
} from './held-balance-apply';
import { HELD_METADATA_SRC, planHeldPassbook } from './held-balance-events';
import { HeldDigestFigures, heldDigestFigures, heldOutletFacts, walletHasActivity } from './held-balance-facts';

export type { HeldDigestFigures };

type Actor = { sub: string; clientId: string; role?: string; assumed?: boolean };

const STATUSES: HeldOpeningBalanceStatus[] = ['PENDING', 'APPLIED', 'FAILED', 'CANCELLED'];


@Injectable()
export class HeldOpeningBalancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  readonly readMode: ReadEngineMode = (clientId, tx) => this.tenantSettings.getReversalEngineModeUncached(clientId, tx);

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
    const search = q.q?.trim();
    const where: Prisma.HeldOpeningBalanceWhereInput = {
      clientId,
      ...(status ? { status } : {}),
      ...(search ? { outletCode: { contains: search, mode: 'insensitive' } } : {}),
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
    const facts = await heldOutletFacts(this.prisma, clientId, rows.map((r) => r.outletCode));
    return {
      clientId,
      total,
      page,
      pageSize,
      totals,
      rows: rows.map((r) => {
        const f = facts.get(r.outletCode);
        return {
          id: r.id,
          outletCode: r.outletCode,
          outletName: f?.name ?? null,
          outletExists: !!f,
          hasWallet: !!f?.wallet,
          walletHasActivity: f?.wallet ? walletHasActivity(f.wallet) : false,
          closingPoints: r.closingPoints,
          eventCount: Array.isArray(r.events) ? r.events.length : 0,
          source: r.source,
          status: r.status,
          appliedAt: r.appliedAt,
          appliedWalletId: r.appliedWalletId,
          applyMode: r.applyMode,
          sequencing: r.sequencing,
          failureReason: r.failureReason,
          cancelReason: r.cancelReason,
          createdAt: r.createdAt,
        };
      }),
    };
  }

  private async loadRow(clientId: string, id: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    // Tenant isolation: a row of another tenant is a 404, never a cross-tenant read/write.
    const row = await db.heldOpeningBalance.findFirst({ where: { id, clientId } });
    if (!row) throw new NotFoundException('Held opening balance not found for this program');
    return row;
  }

  async preview(actor: Actor, id: string, explicitClientId?: string | null) {
    const clientId = await this.tenant(actor, explicitClientId);
    const row = await this.loadRow(clientId, id);
    const f = (await heldOutletFacts(this.prisma, clientId, [row.outletCode])).get(row.outletCode);
    const base = { id: row.id, outletCode: row.outletCode, closingPoints: row.closingPoints, eventCount: Array.isArray(row.events) ? row.events.length : 0 };
    const blocked = (blockedReason: string) => ({ ...base, canApply: false, blockedReason, mode: null, walletId: f?.wallet?.id ?? null, balanceBefore: f?.wallet?.redeemablePoints ?? null, balanceAfter: null });
    if (row.status !== 'PENDING' && row.status !== 'FAILED') return blocked(`This row is ${row.status} — only a waiting or failed row can be applied.`);
    if (!f) return blocked('The outlet is not on the portal yet — the balance is applied automatically when its KYC is approved.');
    if (!f.wallet) return blocked('The outlet has no wallet yet — the balance is applied automatically when its KYC is approved.');
    const planned = planHeldPassbook(row.outletCode, row.closingPoints, row.events, row.eventTotals ?? undefined);
    if (!planned.ok) return blocked(`The held passbook does not tie out — ${planned.reason}. Fix the row (re-load it) first.`);
    const active = walletHasActivity(f.wallet);
    const before = f.wallet.redeemablePoints;
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
    const note = reason?.trim() || null;
    const result = await this.prisma.$transaction(
      async (tx) => {
        const row = await this.loadRow(clientId, id, tx);
        if (row.status !== 'PENDING' && row.status !== 'FAILED') {
          throw new ConflictException(`This held opening balance is ${row.status} — nothing was changed.`);
        }
        const f = (await heldOutletFacts(tx, clientId, [row.outletCode])).get(row.outletCode);
        if (!f?.partnerId || !f.wallet) {
          throw new ConflictException('The outlet has no wallet yet — it is applied automatically at KYC approval. Nothing was changed.');
        }
        const walletId = f.wallet.id;
        const full = await applyHeldRowToPristineWallet(tx, row.id, walletId, {
          trigger: 'MANUAL',
          actorId: actor.sub,
          readMode: this.readMode,
          allowedFrom: ['PENDING', 'FAILED'],
        });
        if (full.status === 'SKIPPED') throw new ConflictException(`Nothing was changed: ${full.reason}`);
        if (full.status !== 'NOT_PRISTINE') {
          if (note) await this.auditNote(tx, row.id, actor.sub, note, full.status);
          return full;
        }
        return this.applyAsAdjustment(tx, row, f.partnerId, walletId, actor.sub, note);
      },
      { timeout: 60_000, maxWait: 15_000 },
    );
    const after = await this.prisma.heldOpeningBalance.findUnique({ where: { id } });
    return {
      id,
      status: after?.status ?? result.status,
      appliedAt: after?.appliedAt ?? null,
      balanceBefore: result.balanceBefore ?? null,
      balanceAfter: result.balanceAfter ?? null,
      failureReason: after?.status === 'FAILED' ? after.failureReason : null,
    };
  }

  private async auditNote(tx: Prisma.TransactionClient, heldId: string, actorId: string, note: string, status: string) {
    await tx.auditLog.create({
      data: { action: 'UPDATE', entityType: HELD_AUDIT_ENTITY, entityId: heldId, actorId, metadata: { applyNowReason: note, outcome: status } as Prisma.InputJsonValue },
    });
  }

  /**
   * Wallet already has activity: ONE opening-balance movement through the engine (wallet.postHeldOpeningAdjustment),
   * verified to move the balance by exactly the closing; else rolled back (savepoint) and FAILED with the reason.
   */
  private async applyAsAdjustment(
    tx: Prisma.TransactionClient,
    row: { id: string; clientId: string; outletCode: string; source: string; closingPoints: number; status: string },
    partnerId: string,
    walletId: string,
    actorId: string,
    note: string | null,
  ): Promise<HeldApplyOutcome> {
    const allowedFrom: Array<'PENDING' | 'FAILED'> = ['PENDING', 'FAILED'];
    const fail = async (reason: string): Promise<HeldApplyOutcome> => {
      await markHeldFailed(tx, [row], reason, { trigger: 'MANUAL', actorId, allowedFrom });
      return { heldId: row.id, outletCode: row.outletCode, status: 'FAILED' as const, reason, walletId };
    };
    await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
    const before = (await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { redeemablePoints: true } })).redeemablePoints;
    const sp = `held_ob_adj_${row.id.replace(/[^a-zA-Z0-9_]/g, '')}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      const sid = `${row.outletCode}:held-open:${row.id}`;
      const mv = await this.wallet.postHeldOpeningAdjustment(tx, partnerId, row.closingPoints, {
        description: `Opening balance carried from the previous programme (${row.source})`,
        sourceId: sid,
        metadata: { src: HELD_METADATA_SRC, batch: row.source, ref: sid, heldOpeningBalanceId: row.id, mode: 'OPENING_ADJUSTMENT' },
      });
      const after = (await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { redeemablePoints: true, movementSeq: true } })).redeemablePoints;
      if (after !== before + row.closingPoints || mv.newRedeemable !== after) {
        throw new Error(`the balance moved from ${before} to ${after} pts, expected ${before + row.closingPoints} (wallet debt or a floor absorbed part of it)`);
      }
      const seq = (await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { movementSeq: true } })).movementSeq;
      const claimed = await tx.heldOpeningBalance.updateMany({
        where: { id: row.id, status: { in: allowedFrom } },
        data: {
          status: 'APPLIED',
          appliedAt: new Date(),
          appliedWalletId: walletId,
          applyMode: 'OPENING_ADJUSTMENT',
          appliedBy: actorId,
          sequencing: seq > 0 ? 'ENGINE (V2 tracked)' : 'ENGINE (LEGACY path)',
          failureReason: null,
          failedAt: null,
        },
      });
      if (claimed.count !== 1) throw new Error('the held row changed meanwhile (already applied or cancelled)');
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: HELD_AUDIT_ENTITY,
          entityId: row.id,
          actorId,
          oldValues: { status: row.status, balance: before } as Prisma.InputJsonValue,
          newValues: { status: 'APPLIED', applyMode: 'OPENING_ADJUSTMENT', walletId, balance: after, transactionId: mv.transactionId } as Prisma.InputJsonValue,
          metadata: { clientId: row.clientId, outletCode: row.outletCode, source: row.source, trigger: 'MANUAL', reason: note } as Prisma.InputJsonValue,
        },
      });
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      return { heldId: row.id, outletCode: row.outletCode, status: 'APPLIED' as const, walletId, balanceBefore: before, balanceAfter: after };
    } catch (e) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
      return fail(`opening-balance adjustment rolled back — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** POST :id/cancel — audited; reason required. PENDING / FAILED only. */
  async cancel(actor: Actor, id: string, explicitClientId: string | null | undefined, reason: string | null | undefined) {
    const clientId = await this.tenant(actor, explicitClientId);
    const why = reason?.trim();
    if (!why) throw new BadRequestException('A reason is required to cancel a held opening balance — nothing was changed.');
    return this.prisma.$transaction(async (tx) => {
      const row = await this.loadRow(clientId, id, tx);
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

  /** Daily Ops Digest figures for one tenant (null when the tenant has no held rows → section hidden). */
  digestFigures(clientId: string, window: { startMs: number; endMs: number }): Promise<HeldDigestFigures | null> {
    return heldDigestFigures(this.prisma, clientId, window);
  }
}
