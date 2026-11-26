import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildXlsx } from '../common/xlsx';
import { returnReviewedOrderStock, STOCK_BASELINE_REASON } from './reward-stock';

/** Hard cap on movements one screen / one download returns (a reward with more shows the newest + says so). */
export const STOCK_HISTORY_MAX_ROWS = 5000;

const TYPE_LABEL: Record<string, string> = {
  OPENING: 'Opening',
  REDEEMED: 'Redeemed',
  RETURNED: 'Returned',
  ADJUSTED: 'Adjusted',
};

export interface StockMovementView {
  id: string;
  type: 'OPENING' | 'REDEEMED' | 'RETURNED' | 'ADJUSTED';
  isBaseline: boolean;
  quantity: number;
  balanceAfter: number | null;
  orderId: string | null;
  orderNumber: string | null;
  reason: string | null;
  actorId: string | null;
  actorName: string | null;
  createdAt: Date;
}

const GIFSY_ROLES = new Set(['GIFSY_ADMIN', 'GIFSY_STAFF']);

/** Who-column label: Gifsy viewers see names; a client viewer sees "Gifsy team" / "Vendor" for those actors. */
export function displayActor(viewer: Pick<JwtPayload, 'role'>, actor: { name: string; role: string }): string {
  if (GIFSY_ROLES.has(viewer.role)) return actor.name;
  if (GIFSY_ROLES.has(actor.role)) return 'Gifsy team';
  if (actor.role === 'VENDOR') return 'Vendor';
  return actor.name;
}

/**
 * Stock history reads + the pre-release review decisions (admin catalogue). Tenant-scoped exactly like the admin
 * catalogue CRUD: `clientId = user.clientId` (an assumed Gifsy operator acts inside that tenant).
 */
@Injectable()
export class RewardStockService {
  constructor(private readonly prisma: PrismaService) {}

  private async loadReward(user: JwtPayload, rewardId: string) {
    // Soft-deleted rewards stay readable: their history is still an audit record.
    const reward = await this.prisma.rewardCatalog.findFirst({
      where: { id: rewardId, clientId: user.clientId },
      select: { id: true, code: true, name: true, stockQuantity: true, status: true, clientId: true, deletedAt: true },
    });
    if (!reward) throw new NotFoundException('Reward item not found');
    return reward;
  }

  /** GET /v1/admin/rewards/catalog/:id/stock-history — summary + every movement (newest first) + open reviews. */
  async getHistory(user: JwtPayload, rewardId: string) {
    const reward = await this.loadReward(user, rewardId);
    const [rows, total, reviews] = await Promise.all([
      this.prisma.rewardStockMovement.findMany({
        where: { rewardId, clientId: reward.clientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: STOCK_HISTORY_MAX_ROWS,
      }),
      this.prisma.rewardStockMovement.count({ where: { rewardId, clientId: reward.clientId } }),
      this.prisma.rewardStockReview.findMany({
        where: { rewardId, clientId: reward.clientId, status: 'OPEN' },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Totals over ALL rows (not only the capped page) so the summary is always exact.
    const sums = await this.prisma.rewardStockMovement.groupBy({
      by: ['type'],
      where: { rewardId, clientId: reward.clientId },
      _sum: { quantity: true },
    });
    const sumOf = (t: string) => sums.find((s) => s.type === t)?._sum.quantity ?? 0;
    const opening = await this.prisma.rewardStockMovement.findFirst({
      where: { rewardId, clientId: reward.clientId, type: 'OPENING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const movements = await this.decorate(user, rows);
    return {
      reward: {
        id: reward.id,
        code: reward.code,
        name: reward.name,
        status: reward.status,
        stockQuantity: reward.stockQuantity,
        deleted: reward.deletedAt != null,
      },
      summary: {
        opening: opening?.quantity ?? null,
        openingAt: opening?.createdAt ?? null,
        openingIsBaseline: opening?.reason === STOCK_BASELINE_REASON,
        redeemed: Math.abs(sumOf('REDEEMED')),
        returned: sumOf('RETURNED'),
        adjusted: sumOf('ADJUSTED'),
        current: reward.stockQuantity,
        historyStartedAt: opening?.createdAt ?? null,
      },
      movements,
      total,
      truncated: total > movements.length,
      // GIFSY_ADMIN can open the order detail (the dispatch console is Gifsy-only).
      canOpenOrder: user.role === 'GIFSY_ADMIN',
      pendingReviews: reviews.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        quantity: r.quantity,
        orderStatus: r.orderStatus,
        createdAt: r.createdAt,
      })),
    };
  }

  /** Resolve actor names + order numbers for display (batched, never one query per row). */
  private async decorate(
    viewer: JwtPayload,
    rows: Array<{
      id: string; type: string; quantity: number; balanceAfter: number | null; orderId: string | null;
      reason: string | null; actorId: string | null; createdAt: Date;
    }>,
  ): Promise<StockMovementView[]> {
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((v): v is string => !!v))];
    const orderIds = [...new Set(rows.map((r) => r.orderId).filter((v): v is string => !!v))];
    const [actors, orders] = await Promise.all([
      actorIds.length
        ? this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, role: true } })
        : Promise.resolve([] as { id: string; name: string; role: string }[]),
      orderIds.length
        ? this.prisma.redemptionOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true } })
        : Promise.resolve([] as { id: string; orderNumber: string }[]),
    ]);
    // Owner 2026-11-26: a CLIENT viewer never sees personal names of Gifsy or vendor staff — "Gifsy team" /
    // "Vendor" instead (screen + download). Gifsy viewers see names. The tenant's own users show by name.
    const actorName = new Map(actors.map((a) => [a.id, displayActor(viewer, a)]));
    const orderNo = new Map(orders.map((o) => [o.id, o.orderNumber]));
    return rows.map((r) => ({
      id: r.id,
      type: r.type as StockMovementView['type'],
      isBaseline: r.type === 'OPENING' && r.reason === STOCK_BASELINE_REASON,
      quantity: r.quantity,
      balanceAfter: r.balanceAfter,
      orderId: r.orderId,
      orderNumber: r.orderId ? orderNo.get(r.orderId) ?? null : null,
      reason: r.reason,
      actorId: r.actorId,
      actorName: r.actorId ? actorName.get(r.actorId) ?? null : null,
      createdAt: r.createdAt,
    }));
  }

  /** GET /v1/admin/rewards/catalog/:id/stock-history/export — the same history as an .xlsx. */
  async exportHistory(user: JwtPayload, rewardId: string): Promise<{ buffer: Buffer; filename: string }> {
    const h = await this.getHistory(user, rewardId);
    const when = (d: Date | null) =>
      d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';
    const rows: Record<string, unknown>[] = h.movements.map((m) => ({
      'Date (IST)': when(m.createdAt),
      Type: m.isBaseline ? 'Opening (baseline at go-live of stock history)' : TYPE_LABEL[m.type] ?? m.type,
      Quantity: m.quantity,
      'Stock after': m.balanceAfter ?? 'Unlimited (not tracked)',
      Order: m.orderNumber ?? '',
      By: m.actorName ?? (m.actorId ? 'Unknown user' : m.isBaseline ? 'System (go-live baseline)' : 'System'),
      Details: m.reason ?? '',
    }));
    if (rows.length === 0) {
      rows.push({ 'Date (IST)': '', Type: 'No stock movements recorded yet', Quantity: '', 'Stock after': '', Order: '', By: '', Details: '' });
    }
    const summary: Record<string, unknown>[] = [
      { Item: 'Reward', Value: `${h.reward.name} (${h.reward.code})` },
      {
        Item: h.summary.openingIsBaseline ? 'Opening (baseline at go-live of stock history)' : 'Opening',
        Value: h.summary.opening ?? 'Not recorded',
      },
      { Item: 'History started (IST)', Value: when(h.summary.historyStartedAt) || 'Not started' },
      { Item: 'Redeemed', Value: h.summary.redeemed },
      { Item: 'Returned', Value: h.summary.returned },
      { Item: 'Adjusted (net)', Value: h.summary.adjusted },
      { Item: 'Current stock', Value: h.summary.current ?? 'Unlimited (not tracked)' },
      { Item: 'Returns awaiting review', Value: h.pendingReviews.length },
      ...(h.truncated
        ? [{ Item: 'Note', Value: `Only the newest ${h.movements.length} of ${h.total} movements are listed.` }]
        : []),
      { Item: 'Note', Value: 'Movements before the go-live of stock history are not reconstructed.' },
    ];
    const buffer = buildXlsx([
      { name: 'Stock history', rows },
      { name: 'Summary', rows: summary },
    ]);
    const safeCode = h.reward.code.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'reward';
    return { buffer, filename: `stock-history-${safeCode}-${new Date().toISOString().slice(0, 10)}.xlsx` };
  }

  /** GET /v1/admin/rewards/stock-reviews — the tenant's OPEN pre-release returns (shown as a banner + list). */
  async listReviews(user: JwtPayload) {
    const reviews = await this.prisma.rewardStockReview.findMany({
      where: { clientId: user.clientId, status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const rewardIds: string[] = [...new Set(reviews.map((r) => r.rewardId))];
    const rewards = rewardIds.length
      ? await this.prisma.rewardCatalog.findMany({
          where: { id: { in: rewardIds }, clientId: user.clientId },
          select: { id: true, name: true, code: true, stockQuantity: true },
        })
      : [];
    const byId = new Map(rewards.map((r) => [r.id, r]));
    const total = await this.prisma.rewardStockReview.count({ where: { clientId: user.clientId, status: 'OPEN' } });
    return {
      total,
      items: reviews.map((r) => ({
        id: r.id,
        rewardId: r.rewardId,
        rewardName: byId.get(r.rewardId)?.name ?? null,
        rewardCode: byId.get(r.rewardId)?.code ?? null,
        currentStock: byId.get(r.rewardId)?.stockQuantity ?? null,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        quantity: r.quantity,
        orderStatus: r.orderStatus,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * POST /v1/admin/rewards/stock-reviews/:id/resolve — RETURN (add the quantity back + RETURNED history row) or
   * KEEP (stock unchanged; the decision, actor and note are recorded on the review). One decision per review:
   * the OPEN → decided claim is atomic, so a double click / two admins can never apply it twice.
   */
  async resolveReview(user: JwtPayload, id: string, action: 'RETURN' | 'KEEP', note?: string | null) {
    const why = (note ?? '').trim();
    if (action === 'KEEP' && !why) throw new BadRequestException('A note is required when keeping stock as is.');
    const review = await this.prisma.rewardStockReview.findFirst({ where: { id, clientId: user.clientId } });
    if (!review) throw new NotFoundException('Review item not found');
    if (review.status !== 'OPEN') throw new ConflictException('This item was already decided — refresh the page.');

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.rewardStockReview.updateMany({
        where: { id, clientId: user.clientId, status: 'OPEN' },
        data: {
          status: action === 'RETURN' ? 'RETURNED' : 'KEPT',
          resolvedById: user.sub ?? null,
          resolvedAt: new Date(),
          resolutionNote: why ? why.slice(0, 500) : null,
        },
      });
      if (claim.count === 0) throw new ConflictException('This item was already decided — refresh the page.');
      if (action === 'KEEP') return { status: 'KEPT' as const };
      const res = await returnReviewedOrderStock(tx, {
        rewardId: review.rewardId,
        orderId: review.orderId,
        orderNumber: review.orderNumber,
        quantity: review.quantity,
        actorId: user.sub,
        note: why || null,
      });
      return { status: 'RETURNED' as const, stockAfter: res.balanceAfter, backInStock: res.backInStock };
    });
  }
}
