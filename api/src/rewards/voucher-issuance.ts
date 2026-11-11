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

/**
 * Codes shorter than this are FULLY masked in audit rows / app logs: a last-4 hint on a short code
 * (e.g. an 8-char code) gives away half of it. At 12+ the visible tail is at most a third.
 */
export const VOUCHER_MASK_MIN_LENGTH = 12;

/** "••••" + last 4 for a 12+ char code, else fully "••••" — audit/log display only. */
export function maskVoucherCodeForAudit(code: string | null | undefined): string {
  const t = typeof code === 'string' ? code.trim() : '';
  return t.length >= VOUCHER_MASK_MIN_LENGTH ? `••••${t.slice(-4)}` : '••••';
}

/** What a stored (persisted) copy of the WhatsApp/SMS `code` var shows when a PIN exists. */
export const MASKED_PIN = '••••';

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
    /** Audit event name (default VOUCHER_ISSUED_MANUAL; a set-once PIN add is VOUCHER_PIN_ADDED_MANUAL). */
    event?: string;
  },
): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: args.actorId,
      action: 'UPDATE',
      entityType: 'REDEMPTION_ORDER',
      entityId: args.orderId,
      metadata: {
        event: args.event ?? 'VOUCHER_ISSUED_MANUAL',
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
 * + PIN order → the SAME event/template (the contract stays 5 vars): the WhatsApp SEND carries
 * {{5}} `code` = "<code> | PIN: <pin>" (single line), but NO persisted copy holds the PIN:
 *  - bell/push/SMS body = "Your <name> voucher is ready — card no. and PIN are in My Orders.";
 *  - every STORED vars copy (IN_APP/PUSH variables, the SMS queue row) gets `maskedVars.code` =
 *    "<code> | PIN: ••••" (so the dormant SMS leg, which sends from its stored row, sends it masked);
 *  - the code, the PIN and the combined value are passed as secrets, so a delivery-failure reason
 *    (MessageDeliveryReceipt.failureReason, shown to CLIENT_ADMIN) and the send-failure logs are
 *    scrubbed to "••••". (Secrets are passed on the no-PIN path too — the code alone.)
 * Called on a NEW code AND when a PIN is added later to an already-issued code (set-once) — the
 * member then receives the voucher again, now with the PIN.
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
    const combined = voucherCodeVar(o.voucherCode, pin);

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
        code: combined,
      },
      ...(pin ? { maskedVars: { code: voucherCodeVar(o.voucherCode, MASKED_PIN) } } : {}),
      // Raw AND single-line forms (a provider may echo either); de-duplicated.
      secretValues: pin
        ? [...new Set([combined, o.voucherCode, whatsappSafeVar(o.voucherCode), pin, whatsappSafeVar(pin)])]
        : [o.voucherCode],
      subject: 'Your voucher code',
      body: pin
        ? `Your ${voucherName} voucher is ready — card no. and PIN are in My Orders.`
        : `Your ${voucherName} code: ${o.voucherCode}`,
      url: '/partner/rewards/orders',
      event: 'VOUCHER_ISSUED',
    });
  } catch (e) {
    deps.logger.error(`[voucher] VOUCHER_ISSUED notify failed for order ${orderId} (non-fatal): ${e}`);
  }
}
