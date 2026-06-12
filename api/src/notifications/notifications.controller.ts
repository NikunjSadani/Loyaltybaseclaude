import {
  Controller, Post, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Roles }                   from '../common/decorators/roles.decorator';
import { CurrentUser }             from '../common/decorators/current-user.decorator';
import type { JwtPayload }         from '../common/decorators/current-user.decorator';
import { NotificationsService }    from './notifications.service';
import { EnqueueNotificationDto }  from './dto/notifications.dto';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /** Internal: enqueue a notification manually (admin use) */
  @Post('enqueue')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @HttpCode(HttpStatus.CREATED)
  enqueue(@CurrentUser() _user: JwtPayload, @Body() dto: EnqueueNotificationDto) {
    return this.notificationsService.enqueue(dto);
  }

  /** Internal: trigger queue processing on-demand (useful in staging/debug) */
  @Post('process')
  @Roles('GIFSY_ADMIN')
  @HttpCode(HttpStatus.OK)
  async processNow() {
    await this.notificationsService.processQueue();
    return { message: 'Queue processing triggered' };
  }
}
