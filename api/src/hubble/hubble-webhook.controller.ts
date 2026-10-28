import { Body, Controller, ForbiddenException, Headers, Logger, Post, Req } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Public } from '../common/decorators/roles.decorator';
import { isFixedOtpAllowed } from '../common/fixed-otp';
import { RewardsService } from '../rewards/rewards.service';

/** express Request augmented with the raw body captured in main.ts (for HMAC verification). */
type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * Hubble Money "order terminal status" webhook — `/v1/hubble/webhook`.
 *
 * @Public (Hubble carries no app JWT) and authenticated by Hubble's documented
 * `X-Verify` header = Base64(HMAC-SHA256(rawBody, shared secret)), verified over the
 * EXACT received bytes (main.ts stashes req.rawBody for this path only). Hit DIRECTLY
 * by Hubble (NOT via the FE `/api` edge), so no PUBLIC_PATHS entry is needed on the FE.
 *
 * SAFE DESIGN (per the integration spec): we do NOT trust the webhook body's voucher
 * payload. We extract OUR referenceId (= the RedemptionOrder id) from the body, then
 * RewardsService re-fetches the authoritative status + vouchers via
 * GET /orders/by-reference/:referenceId and applies the terminal transition
 * idempotently (deliver / refund). The webhook is only a nudge to reconcile — so even
 * an unsigned/forged call can at most trigger a reconcile against Hubble's TRUE state;
 * it can never inject a fake voucher or a fake failure. The signature is defense in
 * depth (stops reconcile-spam / enumeration), not the money-integrity control.
 *
 * Fail-closed once HUBBLE_WEBHOOK_SECRET is configured (prod). Dev-bypass only where
 * FIXED_OTP is allowed (non-prod) so staging UAT works before the secret is provisioned.
 */
@Controller('hubble')
export class HubbleWebhookController {
  private readonly logger = new Logger(HubbleWebhookController.name);

  constructor(private readonly rewards: RewardsService) {}

  @Public()
  @Post('webhook')
  async webhook(
    @Req() req: RawBodyRequest,
    @Body() payload: unknown,
    @Headers('x-verify') signature?: string,
  ): Promise<{ ok: true; reconciled: boolean; outcome?: string }> {
    this.assertSignature(req.rawBody, signature, { devBypass: isFixedOtpAllowed() });

    const referenceId = this.extractReferenceId(payload);
    if (!referenceId) {
      // Ack fast on an unrecognised payload — never throw (avoids retry storms), but
      // report that nothing was reconciled so a misconfig is visible in logs.
      this.logger.warn('[hubble webhook] no referenceId found in payload — ignored');
      return { ok: true, reconciled: false };
    }

    // The reconcile is fully idempotent + self-contained (get-by-reference → apply
    // terminal transition). It never throws into the HTTP layer.
    const outcome = await this.rewards.reconcileHubbleOrder(referenceId);
    return { ok: true, reconciled: true, outcome };
  }

  /**
   * Pull our referenceId (= RedemptionOrder id) out of the webhook body. Tolerates
   * the common shapes (top-level, nested under `data`/`order`) so a minor payload
   * variation doesn't drop a callback.
   */
  private extractReferenceId(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const data = (p.data && typeof p.data === 'object' ? p.data : {}) as Record<string, unknown>;
    const order = (p.order && typeof p.order === 'object' ? p.order : {}) as Record<string, unknown>;
    const candidate =
      p.referenceId ??
      p.reference_id ??
      data.referenceId ??
      data.reference_id ??
      order.referenceId ??
      order.reference_id;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  }

  /**
   * Verify Hubble's `X-Verify` header = Base64(HMAC-SHA256(rawBody, HUBBLE_WEBHOOK_SECRET)),
   * using a constant-time compare. Fail-closed when the secret is set (prod); dev-bypass
   * only where FIXED_OTP is allowed (non-prod), so staging UAT works before the secret
   * is provisioned. Computes over the exact received bytes (req.rawBody).
   */
  private assertSignature(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    opts: { devBypass: boolean },
  ): void {
    const secret = process.env.HUBBLE_WEBHOOK_SECRET;
    if (!secret) {
      if (opts.devBypass) return; // non-prod convenience (no secret provisioned yet)
      throw new ForbiddenException('Webhook disabled (no signing secret configured).');
    }
    if (!signature) throw new ForbiddenException('Missing X-Verify signature.');
    const expected = createHmac('sha256', secret)
      .update(rawBody ?? Buffer.alloc(0))
      .digest('base64');
    const got = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new ForbiddenException('Invalid X-Verify signature.');
    }
  }
}
