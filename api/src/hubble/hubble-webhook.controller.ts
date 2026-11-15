import { Body, Controller, ForbiddenException, Headers, Logger, Post, Req } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Public } from '../common/decorators/roles.decorator';
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
 * FAIL-CLOSED in every environment: with no signing secret configured the webhook rejects
 * (403) — there is no dev-bypass. Secret = HUBBLE_WEBHOOK_SECRET (env-neutral; prod + staging
 * bind it), falling back to HUBBLE_WEBHOOK_SECRET_STAGING.
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
    this.assertSignature(req.rawBody, signature);

    const referenceId = this.extractReferenceId(payload);
    if (!referenceId) {
      // Ack fast on an unrecognised payload — never throw (avoids retry storms), but
      // report that nothing was reconciled so a misconfig is visible in logs.
      this.logger.warn('[hubble webhook] no referenceId found in payload — ignored');
      return { ok: true, reconciled: false };
    }

    // The reconcile is fully idempotent + self-contained (get-by-reference → apply
    // terminal transition). It never throws into the HTTP layer.
    const outcome = await this.rewards.reconcileHubbleOrder(referenceId, { webhookStatus: this.extractStatus(payload) });
    return { ok: true, reconciled: true, outcome };
  }

  /** The order status the webhook reports (top-level, or under `data` / `order`), upper-cased; null if none. */
  private extractStatus(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    for (const src of [p, p.data, p.order]) {
      if (src && typeof src === 'object' && typeof (src as Record<string, unknown>).status === 'string') {
        return ((src as Record<string, unknown>).status as string).trim().toUpperCase() || null;
      }
    }
    return null;
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
   * using a constant-time compare. FAIL-CLOSED: no configured secret (unset or blank) → 403 in
   * every environment. Computes over the exact received bytes (req.rawBody).
   */
  private assertSignature(rawBody: Buffer | undefined, signature: string | undefined): void {
    const secret =
      process.env.HUBBLE_WEBHOOK_SECRET?.trim() || process.env.HUBBLE_WEBHOOK_SECRET_STAGING?.trim();
    if (!secret) {
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
