import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { NotificationsService, FeedPage } from './notifications.service';
import { FeedQueryDto } from './dto/notifications.dto';

/**
 * In-app notification "bell feed" API (Phase 1) → /v1/notifications.
 *
 * Standard JWT auth (NOT @Public) — the global JwtAuthGuard protects every route and
 * @CurrentUser injects the caller. EVERY query is scoped to `user.sub`, so a user can
 * only ever read/mark their OWN IN_APP rows (ownership isolation; a foreign id 404s).
 * Responses are enveloped globally by TransformInterceptor.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** GET /v1/notifications?cursor=&limit= — the caller's feed, newest first. */
  @Get()
  list(@CurrentUser() user: JwtPayload, @Query() query: FeedQueryDto): Promise<FeedPage> {
    return this.notifications.listFeed(user.sub, query.cursor, query.limit ?? 25);
  }

  /** GET /v1/notifications/unread-count — the caller's unread IN_APP count. */
  @Get('unread-count')
  unreadCount(@CurrentUser() user: JwtPayload): Promise<{ count: number }> {
    return this.notifications.unreadCount(user.sub);
  }

  /** POST /v1/notifications/:id/read — mark one of the caller's rows read (idempotent, 404 if not owned). */
  @Post(':id/read')
  markRead(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<{ id: string; readAt: Date }> {
    return this.notifications.markRead(user.sub, id);
  }

  /** POST /v1/notifications/read-all — mark all the caller's unread rows read. */
  @Post('read-all')
  markAllRead(@CurrentUser() user: JwtPayload): Promise<{ updated: number }> {
    return this.notifications.markAllRead(user.sub);
  }
}
