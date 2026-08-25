import { Body, Controller, ForbiddenException, Headers, Post, Query } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Public } from '../common/decorators/roles.decorator';
import { isFixedOtpAllowed } from '../common/fixed-otp';
import { MessageDeliveryStatusService } from './message-delivery-status.service';

/**
 * Transactional delivery-status ops — `/v1/notifications/*`. All @Public (hit by MSG91 / Cloud
 * Scheduler, which carry no JWT) and secret-guarded with a constant-time compare.
 *
 * Hit DIRECTLY by MSG91 / the scheduler (NOT via the FE `/api` edge), so these need no
 * PUBLIC_PATHS entry on the frontend — they are @Public on the backend only.
 */
@Controller('notifications')
export class NotificationsStatusController {
  constructor(private readonly status: MessageDeliveryStatusService) {}

  /**
   * POST /v1/notifications/status — MSG91 SMS DLR (delivery-report) webhook (Wave 1; Wave 2 reuses
   * it for transactional WhatsApp).
   *
   * Secret: `NOTIFICATIONS_STATUS_SECRET` matched (constant-time) against the `x-webhook-secret`
   * header OR a `?secret=` query param (MSG91 lets you configure either). DEV-BYPASS only when the
   * env secret is UNSET AND this is a NON-prod data plane (`isFixedOtpAllowed()` — the same gate as
   * the other MSG91 bypasses) so local/staging can exercise the webhook without a secret, while a
   * PROD deploy missing NOTIFICATIONS_STATUS_SECRET FAILS CLOSED (rejects unauthenticated status
   * writes) instead of silently accepting them. Acks fast → the handler does only the minimal
   * guarded row update(s) and returns. Never throws on a bad/partial payload.
   */
  @Public()
  @Post('status')
  async statusWebhook(
    @Body() payload: unknown,
    @Headers('x-webhook-secret') headerSecret?: string,
    @Query('secret') querySecret?: string,
  ): Promise<{ ok: true; processed: number; updated: number }> {
    // Fail-closed on prod: the dev-bypass is only honored where FIXED_OTP would be (non-prod).
    this.assertSecret('NOTIFICATIONS_STATUS_SECRET', headerSecret ?? querySecret, {
      devBypass: isFixedOtpAllowed(),
    });
    const res = await this.status.handleWebhook(payload);
    return { ok: true, ...res };
  }

  /**
   * POST /v1/notifications/status/reconcile — scheduled fallback poll: reconcile SMS receipts stuck
   * at SENT via the MSG91 status-by-requestId API (catches missed DLR webhooks). Secret:
   * `NOTIFICATIONS_STATUS_SECRET`, FAIL-CLOSED (unset → refuse; never an open trigger — a scheduler
   * trigger has no non-prod convenience need). Fail-safe inside (never throws on a bad row).
   */
  @Public()
  @Post('status/reconcile')
  async reconcile(
    @Headers('x-webhook-secret') headerSecret?: string,
    @Query('secret') querySecret?: string,
  ): Promise<{ ok: true; checked: number; updated: number }> {
    this.assertSecret('NOTIFICATIONS_STATUS_SECRET', headerSecret ?? querySecret, {
      devBypass: false,
    });
    const res = await this.status.reconcile();
    return { ok: true, ...res };
  }

  /**
   * Constant-time secret check (copied from whatsapp-ops.controller).
   *   - devBypass:true  → an UNSET env secret ALLOWS (non-prod webhook convenience, like the
   *     other MSG91 secrets). A SET secret is always enforced.
   *   - devBypass:false → an UNSET env secret REFUSES (fail-closed ops trigger).
   */
  private assertSecret(
    envKey: string,
    provided: string | undefined,
    opts: { devBypass: boolean },
  ): void {
    const expected = process.env[envKey];
    if (!expected) {
      if (opts.devBypass) return; // non-prod convenience
      throw new ForbiddenException('Endpoint disabled (no secret configured).');
    }
    const got = Buffer.from(provided ?? '');
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new ForbiddenException('Invalid secret.');
    }
  }
}
