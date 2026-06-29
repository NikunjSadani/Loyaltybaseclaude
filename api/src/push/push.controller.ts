import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Public, Roles } from '../common/decorators/roles.decorator';
import { PushSubscriptionService } from './push-subscription.service';
import { PushSenderService } from './push-sender.service';
import { PushDeliveryWorker } from './push-delivery.worker';
import { PwaAdoptionService, AdoptionReport } from './pwa-adoption.service';
import { SubscribeDto, UnsubscribeDto, ReportInstallDto } from './dto/push.dto';

/**
 * Web Push (PWA) API — re-homed onto /v1/push. Auth (JWT) + tenant scope come from
 * @CurrentUser(); a subscription always belongs to the authenticated user+clientId,
 * NEVER to a body-supplied id. Responses are enveloped globally by TransformInterceptor.
 *
 * No @RequirePermission/@Roles: any authenticated user may manage their OWN push
 * subscriptions (the JWT scopes every operation to `sub`).
 */
@Controller('push')
export class PushController {
  constructor(
    private readonly subscriptions: PushSubscriptionService,
    private readonly sender: PushSenderService,
    private readonly worker: PushDeliveryWorker,
    private readonly adoption: PwaAdoptionService,
  ) {}

  /**
   * POST /v1/push/installed — installed-PWA beacon. The client fires this when it
   * detects the app is running standalone (home-screen install). Records who has
   * installed, per platform; userId/clientId come from the JWT, never the body.
   */
  @Post('installed')
  reportInstall(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ReportInstallDto,
  ): Promise<{ ok: true }> {
    return this.adoption.recordInstall(
      user.sub,
      user.clientId,
      dto.platform,
      dto.userAgent ?? null,
    );
  }

  /**
   * GET /v1/push/adoption — PWA adoption stats for the admin "App Adoption" page.
   * Tenant-scoped to the caller's clientId (CLIENT_ADMIN → own tenant; GIFSY_ADMIN →
   * the tenant they've assumed). MIS_USER may read too.
   */
  @Get('adoption')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER')
  getAdoption(@CurrentUser() user: JwtPayload): Promise<AdoptionReport> {
    return this.adoption.adoption(user.clientId);
  }

  /**
   * POST /v1/push/drain — Cloud-Scheduler-triggered queue drain.
   *
   * Cloud Run throttles CPU between requests, so the worker's @Interval timer does
   * not fire reliably while the instance is idle. A scheduler pings this endpoint
   * every ~60s; the request itself un-throttles the CPU and we run one drain pass.
   *
   * @Public (Cloud Scheduler carries no JWT) but gated by a shared secret in the
   * `x-drain-secret` header matched against PUSH_DRAIN_SECRET. FAIL-CLOSED: if the
   * env secret is unset the endpoint refuses, so it is never an open trigger. The
   * worst case of a leaked secret is an early drain (identical to the timer firing),
   * never data exposure — the body has no user input and reads only QUEUED rows.
   */
  @Public()
  @Post('drain')
  async drain(@Headers('x-drain-secret') secret?: string): Promise<{ ok: true }> {
    const expected = process.env.PUSH_DRAIN_SECRET;
    // Fail-closed: no configured secret → never an open trigger. Constant-time compare.
    if (!expected) throw new ForbiddenException('Drain disabled');
    const got = Buffer.from(secret ?? '');
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new ForbiddenException('Invalid drain secret');
    }
    await this.worker.drain();
    return { ok: true };
  }

  /** GET /v1/push/vapid-public-key — the platform-wide VAPID public key (or "" if unset). */
  @Get('vapid-public-key')
  getVapidPublicKey(): { publicKey: string } {
    return { publicKey: this.sender.publicKey };
  }

  /** POST /v1/push/subscribe — UPSERT this browser's subscription for the current user. */
  @Post('subscribe')
  subscribe(@CurrentUser() user: JwtPayload, @Body() dto: SubscribeDto): Promise<{ id: string }> {
    return this.subscriptions.upsert({
      userId: user.sub,
      clientId: user.clientId,
      endpoint: dto.endpoint,
      p256dh: dto.keys.p256dh,
      auth: dto.keys.auth,
      userAgent: dto.userAgent ?? null,
    });
  }

  /** POST /v1/push/unsubscribe — delete this endpoint's subscription for the current user. */
  @Post('unsubscribe')
  unsubscribe(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UnsubscribeDto,
  ): Promise<{ success: true }> {
    return this.subscriptions.remove(user.sub, dto.endpoint);
  }
}
