import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { PushSubscriptionService } from './push-subscription.service';
import { PushSenderService } from './push-sender.service';
import { SubscribeDto, UnsubscribeDto } from './dto/push.dto';

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
  ) {}

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
