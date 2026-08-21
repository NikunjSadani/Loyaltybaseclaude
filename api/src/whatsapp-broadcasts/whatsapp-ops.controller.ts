import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Post,
  Query,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Public } from '../common/decorators/roles.decorator';
import { isFixedOtpAllowed } from '../common/fixed-otp';
import { WhatsappStatusService } from './whatsapp-status.service';
import { WhatsappSendWorker } from './whatsapp-send.worker';

/**
 * WhatsApp delivery-pipeline ops — `/v1/whatsapp/*`. All @Public (hit by MSG91 / Cloud
 * Scheduler, which carry no JWT) and secret-guarded with a constant-time compare.
 *
 * Hit DIRECTLY by MSG91 / the scheduler (NOT via the FE `/api` edge), so these need no
 * PUBLIC_PATHS entry on the frontend — they are @Public on the backend only.
 */
@Controller('whatsapp')
export class WhatsappOpsController {
  constructor(
    private readonly status: WhatsappStatusService,
    private readonly worker: WhatsappSendWorker,
  ) {}

  /**
   * POST /v1/whatsapp/status — MSG91 "On Outbound Report Received" webhook.
   *
   * Secret: `WHATSAPP_STATUS_SECRET` matched (constant-time) against the `x-webhook-secret`
   * header OR a `?secret=` query param (MSG91 lets you configure either). DEV-BYPASS only when
   * the env secret is UNSET AND this is a NON-prod data plane (`isFixedOtpAllowed()` — the same
   * gate as the other MSG91 bypasses) so local/staging can exercise the webhook without a
   * secret, while a PROD deploy missing WHATSAPP_STATUS_SECRET FAILS CLOSED (rejects
   * unauthenticated status writes) instead of silently accepting them. Must ack ≤8s → the
   * handler does only the minimal guarded row update(s) and returns. Never throws on a
   * bad/partial payload.
   */
  @Public()
  @Post('status')
  async statusWebhook(
    @Body() payload: unknown,
    @Headers('x-webhook-secret') headerSecret?: string,
    @Query('secret') querySecret?: string,
  ): Promise<{ ok: true; processed: number; updated: number }> {
    // Fail-closed on prod: the dev-bypass is only honored where FIXED_OTP would be (non-prod).
    this.assertSecret('WHATSAPP_STATUS_SECRET', headerSecret ?? querySecret, {
      devBypass: isFixedOtpAllowed(),
    });
    const res = await this.status.handleWebhook(payload);
    return { ok: true, ...res };
  }

  /**
   * POST /v1/whatsapp/drain — Cloud-Scheduler-triggered send drain (Cloud Run throttles CPU
   * between requests, so the @Interval doesn't fire reliably while idle). Secret:
   * `WHATSAPP_DRAIN_SECRET`, FAIL-CLOSED (unset → refuse; never an open trigger). The worker
   * itself is additionally gated by WHATSAPP_WORKER_ENABLED.
   */
  @Public()
  @Post('drain')
  async drain(@Headers('x-drain-secret') secret?: string): Promise<{ ok: true }> {
    this.assertSecret('WHATSAPP_DRAIN_SECRET', secret, { devBypass: false });
    await this.worker.drain();
    return { ok: true };
  }

  /**
   * POST /v1/whatsapp/status/reconcile — scheduled fallback poll: reconcile non-terminal
   * recipients via the MSG91 status-by-requestID API (catches missed webhooks). Secret:
   * `WHATSAPP_DRAIN_SECRET`, FAIL-CLOSED. Fail-safe inside (never throws on a bad row).
   */
  @Public()
  @Post('status/reconcile')
  async reconcile(
    @Headers('x-drain-secret') secret?: string,
  ): Promise<{ ok: true; checked: number; updated: number }> {
    this.assertSecret('WHATSAPP_DRAIN_SECRET', secret, { devBypass: false });
    const res = await this.status.reconcile();
    return { ok: true, ...res };
  }

  /**
   * Constant-time secret check.
   *   - devBypass:true  → an UNSET env secret ALLOWS (non-prod webhook convenience, like the
   *     other MSG91 secrets). A SET secret is always enforced.
   *   - devBypass:false → an UNSET env secret REFUSES (fail-closed ops trigger, like push drain).
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
