import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { NotificationsService } from '../notifications/notifications.service';
import type { EventKey } from '../notification-templates/notification-templates.config';

/**
 * Shared side effects of a MANUAL voucher issuance (a NEW code written by the Gifsy console /
 * bulk sheet / vendor portal) — one implementation so every write path audits + notifies alike:
 *  - recordVoucherIssuedAudit: an AuditLog row (who, which path, MASKED code — never the code);
 *  - notifyVoucherIssued: the member's VOUCHER_ISSUED bell + configured channels (the code is
 *    the member's own credential — it IS sent to them, exactly as transitionOrder always did).
 */

type Db = Prisma.TransactionClient | { auditLog: Prisma.TransactionClient['auditLog'] };

/** "••••" + last 4 for an 8+ char code, else fully masked — audit/log display only. */
export function maskVoucherCodeForAudit(code: string): string {
  const t = code.trim();
  return t.length >= 8 ? `••••${t.slice(-4)}` : '••••';
}

export async function recordVoucherIssuedAudit(
  db: Db,
  args: { actorId: string | null; orderId: string; code: string; path: string; provider?: string | null },
): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: args.actorId,
      action: 'UPDATE',
      entityType: 'REDEMPTION_ORDER',
      entityId: args.orderId,
      metadata: {
        event: 'VOUCHER_ISSUED_MANUAL',
        path: args.path,
        voucherCode: maskVoucherCodeForAudit(args.code),
        voucherProvider: args.provider ?? null,
      },
    },
  });
}

/** "<Brand> Loyalty" for the tenant (branding.displayName → internalName → id). Never throws. */
export async function programLabelFor(
  prisma: { client: { findUnique: (a: Prisma.ClientFindUniqueArgs) => Promise<unknown> } },
  clientId: string,
): Promise<string> {
  try {
    const c = (await prisma.client.findUnique({
      where: { id: clientId },
      select: { branding: true, internalName: true },
    })) as { branding?: unknown; internalName?: string | null } | null;
    const brand = ((c?.branding ?? {}) as Record<string, unknown>).displayName;
    const name = typeof brand === 'string' && brand.trim() ? brand.trim() : c?.internalName ?? clientId;
    return `${name} Loyalty`;
  } catch {
    return 'Loyalty';
  }
}

/** Send the member their VOUCHER_ISSUED notification. Best-effort: never throws. */
export async function notifyVoucherIssued(
  deps: {
    prisma: {
      redemptionOrder: { findUnique: (a: Prisma.RedemptionOrderFindUniqueArgs) => Promise<unknown> };
      client: { findUnique: (a: Prisma.ClientFindUniqueArgs) => Promise<unknown> };
    };
    notifications: Pick<NotificationsService, 'notifyUserWithChannels'>;
    logger: Logger;
  },
  orderId: string,
  clientId: string,
): Promise<void> {
  try {
    const o = (await deps.prisma.redemptionOrder.findUnique({
      where: { id: orderId },
      select: {
        voucherCode: true,
        valuePaise: true,
        orderNumber: true,
        reward: { select: { name: true } },
        partner: { select: { userId: true, phone: true, ownerName: true } },
      },
    })) as {
      voucherCode: string | null;
      valuePaise: bigint | null;
      reward?: { name?: string } | null;
      partner?: { userId?: string | null; phone?: string | null; ownerName?: string | null } | null;
    } | null;
    // Nothing to send without a code and a login user to deliver the bell to.
    if (!o?.voucherCode || !o.partner?.userId) return;

    const program = await programLabelFor(deps.prisma, clientId);
    const amount = o.valuePaise != null ? `₹${(Number(o.valuePaise) / 100).toLocaleString('en-IN')}` : '';
    const voucherName = o.reward?.name ?? 'voucher';

    await deps.notifications.notifyUserWithChannels({
      clientId,
      userId: o.partner.userId,
      eventKey: 'VOUCHER_ISSUED' as EventKey,
      recipientPhone: o.partner.phone ?? null,
      vars: {
        ownerName: o.partner.ownerName ?? 'Partner',
        amount,
        program,
        voucherName,
        code: o.voucherCode,
      },
      subject: 'Your voucher code',
      body: `Your ${voucherName} code: ${o.voucherCode}`,
      url: '/partner/rewards/orders',
      event: 'VOUCHER_ISSUED',
    });
  } catch (e) {
    deps.logger.error(`[voucher] VOUCHER_ISSUED notify failed for order ${orderId} (non-fatal): ${e}`);
  }
}
