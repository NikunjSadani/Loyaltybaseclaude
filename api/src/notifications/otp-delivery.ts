import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

const logger = new Logger('OtpDeliveryCapture');

/**
 * Light D1 OTP delivery tracking (Wave 3) — best-effort capture of MSG91's returned OTP request id
 * onto the just-created OtpCode row, marking it dispatched (`deliveryStatus = SENT`).
 *
 * The stored `msg91RequestId` is the SOLE correlation key an OTP delivery-report later uses
 * (MessageDeliveryStatusService.applyEvent → the OtpCode fallback) to flip the row DELIVERED/FAILED,
 * which feeds the aggregate OTP delivery-rate. OTP is NOT given a full per-message receipt table
 * (that is MessageDeliveryReceipt, for SMS/transactional WhatsApp) — see DELIVERY-STATUS-REPORTING-SCOPE.md §6 (D1).
 *
 * SAFETY — this NEVER throws: every failure is swallowed so OTP send/verify behaviour is completely
 * unchanged whether or not the capture succeeds. Call it AFTER a successful send, best-effort.
 *   - A `null` requestId (FIXED_OTP or missing-authKey DEV bypass) is stored as-is; the row is still
 *     marked SENT (it was dispatched). With no requestId it simply can't be correlated later — fine.
 *   - Idempotent + no-clobber: guarded on `deliveryStatus: null`, so a re-entry (or a callback that
 *     somehow already flipped the row) is a no-op and never downgrades a terminal status. A callback
 *     cannot pre-empt this write anyway — correlation needs the msg91RequestId this call writes.
 *
 * @param prisma      the Prisma client (passed in — no DI wiring, so no new provider on the callers)
 * @param otpCodeId   the id of the OtpCode row just created for this send (no-op when falsy)
 * @param sendResult  the `{ requestId }` returned by msg91.sendOtp (requestId may be null)
 */
export async function captureOtpDeliveryHandle(
  prisma: PrismaService,
  otpCodeId: string | undefined | null,
  sendResult: { requestId: string | null } | undefined,
): Promise<void> {
  if (!otpCodeId) return;
  try {
    await prisma.otpCode.updateMany({
      // Guard on deliveryStatus:null so this only writes the initial SENT + handle once (idempotent,
      // no-downgrade). A fresh OtpCode defaults deliveryStatus to null.
      where: { id: otpCodeId, deliveryStatus: null },
      data: { msg91RequestId: sendResult?.requestId ?? null, deliveryStatus: 'SENT' },
    });
  } catch (e) {
    // Best-effort ONLY — a capture failure must never affect the OTP send/verify flow.
    logger.warn(`[otp-delivery] request-id capture failed for OtpCode ${otpCodeId}: ${e}`);
  }
}
