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

/**
 * A WhatsApp template variable must be ONE line: no newline / tab, and never 4+ consecutive
 * spaces (Meta rejects the send). Collapse every whitespace run to a single space and trim.
 */
export function whatsappSafeVar(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

/**
 * The `code` variable for an order: the code alone (byte-identical to the pre-PIN behaviour) when
 * there is no PIN; "<code> | PIN: <pin>" (single line) for a card number + PIN gift card.
 */
export function voucherCodeVar(code: string, pin: string | null | undefined): string {
  const p = typeof pin === 'string' ? whatsappSafeVar(pin) : '';
  if (!p) return code;
  return `${whatsappSafeVar(code)} | PIN: ${p}`;
}

/** "••••" + last 4 for an 8+ char code, else fully masked — audit/log display only. */
export function maskVoucherCodeForAudit(code: string): string {
  const t = code.trim();
  return t.length >= 8 ? `••••${t.slice(-4)}` : '••••';
}

export async function recordVoucherIssuedAudit(
  db: Db,
  args: {
    actorId: string | null;
    orderId: string;
    code: string;
    path: string;
    provider?: string | null;
    /** Set when a GIFSY_ADMIN manually fulfilled a Hubble-handed order (the ops exit). */
    overrideReason?: string | null;
    /** The PIN written alongside the code (card+PIN voucher) — audited MASKED only, never in clear. */
    pin?: string | null;
  },
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
        // Only the FACT of a PIN, fully masked like a short code — the PIN itself is never logged.
        ...(args.pin ? { voucherPin: '••••' } : {}),
        voucherProvider: args.provider ?? null,
        ...(args.overrideReason ? { manualOverride: true, overrideReason: args.overrideReason } : {}),
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

/**
 * Send the member their VOUCHER_ISSUED notification (`voucher_code` template). Best-effort: never
 * throws. No PIN on the order → vars + body byte-identical to the pre-PIN behaviour. A card number
 * + PIN order → the SAME event/template (the contract stays 5 vars) with {{5}} `code` =
 * "<code> | PIN: <pin>" (single line), and bell/SMS body "Your <name> card no: <code> · PIN: <pin>".
 */
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
        voucherPin: true,
        valuePaise: true,
        orderNumber: true,
        reward: { select: { name: true } },
        partner: { select: { userId: true, phone: true, ownerName: true } },
      },
    })) as {
      voucherCode: string | null;
      voucherPin?: string | null;
      valuePaise: bigint | null;
      reward?: { name?: string } | null;
      partner?: { userId?: string | null; phone?: string | null; ownerName?: string | null } | null;
    } | null;
    // Nothing to send without a code and a login user to deliver the bell to.
    if (!o?.voucherCode || !o.partner?.userId) return;

    const program = await programLabelFor(deps.prisma, clientId);
    const amount = o.valuePaise != null ? `₹${(Number(o.valuePaise) / 100).toLocaleString('en-IN')}` : '';
    const voucherName = o.reward?.name ?? 'voucher';
    const pin = typeof o.voucherPin === 'string' && o.voucherPin.trim() ? o.voucherPin.trim() : null;

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
        code: voucherCodeVar(o.voucherCode, pin),
      },
      subject: 'Your voucher code',
      body: pin
        ? `Your ${voucherName} card no: ${o.voucherCode} · PIN: ${pin}`
        : `Your ${voucherName} code: ${o.voucherCode}`,
      url: '/partner/rewards/orders',
      event: 'VOUCHER_ISSUED',
    });
  } catch (e) {
    deps.logger.error(`[voucher] VOUCHER_ISSUED notify failed for order ${orderId} (non-fatal): ${e}`);
  }
}
