import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ListGstReimbursementQueryDto, ReleaseGstReimbursementDto } from './dto/gst-reimbursement.dto';

/**
 * GST-reimbursement (GST holdback → release) service — Wave 1 Stream C, design D5.
 *
 * When a SERVICE AutoInvoice is generated for a GST-registered retailer, the retailer is paid
 * the base immediately but the GST is HELD (a GstReimbursement row, status=HELD). Gifsy releases
 * it only on the retailer's proof of GST deposit + the reimbursement payout reference — flipping
 * HELD → RELEASED and stamping proofUrl / releasePayoutRef / releasedAt / releasedById.
 *
 * This service NEVER creates holdback rows (that happens at invoice generation in Stream B) — it
 * only LISTS and RELEASES them. GIFSY_ADMIN-only; enforced on the controller via @Roles.
 *
 * Money is integer paise (BigInt). All paise fields are serialised to strings before return
 * (JSON.stringify cannot encode BigInt); a rupee mirror (paise ÷ 100) is added for display.
 */
@Injectable()
export class GstReimbursementService {
  constructor(private readonly prisma: PrismaService) {}

  /** paise (BigInt) → { paise: string, inr: number } for a JSON-safe money field. */
  private money(paise: bigint): { paise: string; inr: number } {
    return { paise: paise.toString(), inr: Number(paise) / 100 };
  }

  /**
   * GET /v1/admin/gst-reimbursements — list reimbursement rows (default the HELD release queue).
   * Optional filters: status (HELD|RELEASED), clientId (single tenant), period (linked invoice period).
   * Ordered oldest-held first so the release queue is FIFO.
   */
  async list(query: ListGstReimbursementQueryDto) {
    const status = query.status ?? 'HELD';

    const where: Prisma.GstReimbursementWhereInput = { status };
    if (query.clientId) where.clientId = query.clientId;
    // period lives on the linked SERVICE invoice, not the holdback row.
    if (query.period) where.autoInvoice = { period: query.period };

    const rows = await this.prisma.gstReimbursement.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: {
        autoInvoice: {
          select: { invoiceNumber: true, period: true, invoiceDate: true, gstType: true },
        },
      },
    });

    const items = rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      autoInvoiceId: r.autoInvoiceId,
      invoiceNumber: r.autoInvoice?.invoiceNumber ?? null,
      period: r.autoInvoice?.period ?? null,
      gstType: r.autoInvoice?.gstType ?? null,
      partnerId: r.partnerId,
      outletCode: r.outletCode,
      status: r.status,
      gst: this.money(r.gstPaise),
      proofUrl: r.proofUrl,
      releasePayoutRef: r.releasePayoutRef,
      releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
      releasedById: r.releasedById,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    }));

    const totalGstPaise = rows.reduce((s, r) => s + r.gstPaise, 0n);

    return {
      status,
      clientId: query.clientId ?? null,
      period: query.period ?? null,
      count: items.length,
      totalGst: this.money(totalGstPaise),
      items,
    };
  }

  /**
   * POST /v1/admin/gst-reimbursements/:id/release — flip a HELD row to RELEASED.
   *
   * Idempotency + race-safety: the write is a conditional updateMany scoped to
   * { id, status: HELD }. If it updates 0 rows we disambiguate:
   *   - row does not exist            → 404 NotFound
   *   - row exists but already RELEASED → 409 Conflict (idempotent no-op signal; never double-releases)
   */
  async release(user: JwtPayload, id: string, dto: ReleaseGstReimbursementDto) {
    const now = new Date();

    const { count } = await this.prisma.gstReimbursement.updateMany({
      where: { id, status: 'HELD' },
      data: {
        status: 'RELEASED',
        proofUrl: dto.proofUrl,
        releasePayoutRef: dto.releasePayoutRef,
        notes: dto.notes ?? null,
        releasedAt: now,
        releasedById: user.sub,
      },
    });

    if (count === 0) {
      const existing = await this.prisma.gstReimbursement.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!existing) throw new NotFoundException('GST reimbursement not found');
      // Already RELEASED — do not re-stamp proof/payout/releasedBy; report a conflict.
      throw new ConflictException('GST reimbursement is already released');
    }

    // Audit the release (money-adjacent state change). entityId = the reimbursement row.
    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'GstReimbursement',
        entityId: id,
        actorId: user.sub,
        metadata: {
          event: 'gst_reimbursement_release',
          releasePayoutRef: dto.releasePayoutRef,
          proofUrl: dto.proofUrl,
        },
      },
    });

    const released = await this.prisma.gstReimbursement.findUnique({
      where: { id },
      include: {
        autoInvoice: { select: { invoiceNumber: true, period: true } },
      },
    });

    return {
      id,
      status: 'RELEASED' as const,
      clientId: released?.clientId ?? null,
      invoiceNumber: released?.autoInvoice?.invoiceNumber ?? null,
      period: released?.autoInvoice?.period ?? null,
      outletCode: released?.outletCode ?? null,
      gst: released ? this.money(released.gstPaise) : null,
      proofUrl: dto.proofUrl,
      releasePayoutRef: dto.releasePayoutRef,
      releasedAt: now.toISOString(),
      releasedById: user.sub,
    };
  }
}
