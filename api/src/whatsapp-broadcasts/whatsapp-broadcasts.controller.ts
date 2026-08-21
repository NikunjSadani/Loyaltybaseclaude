import {
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { WhatsappBroadcastsService } from './whatsapp-broadcasts.service';
import {
  CreateBroadcastDto,
  PreviewBroadcastDto,
  TestSendDto,
} from './dto/whatsapp-broadcast.dto';

/**
 * WhatsApp broadcasts — `/v1/admin/whatsapp-broadcasts`. Gifsy-operator only.
 *
 * `@Roles('GIFSY_ADMIN')` (no `@RequirePermission`) → RolesGuard 403s every tenant role
 * AND un-permissioned GIFSY_STAFF (allow-list fall-through), same as the templates + the
 * notification-templates controllers. The service re-checks isGifsyOperator at the data
 * boundary and pins everything to the operator's ASSUMED tenant (`user.clientId`).
 *
 * NOTE (deviation from the doc's `:id/test-send`): test-send is a PRE-campaign wizard step
 * (send to myself before the broadcast exists), so it takes a templateId in the body and
 * has NO `:id` — `POST /admin/whatsapp-broadcasts/test-send`.
 */
@Controller('admin/whatsapp-broadcasts')
@Roles('GIFSY_ADMIN')
export class WhatsappBroadcastsController {
  constructor(private readonly svc: WhatsappBroadcastsService) {}

  @Post('preview')
  preview(@CurrentUser() user: JwtPayload, @Body() dto: PreviewBroadcastDto) {
    return this.svc.preview(user, dto);
  }

  @Post('test-send')
  testSend(@CurrentUser() user: JwtPayload, @Body() dto: TestSendDto) {
    return this.svc.testSend(user, dto);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateBroadcastDto) {
    return this.svc.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.svc.list(user);
  }

  @Get(':id')
  detail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.detail(user, id);
  }

  @Get(':id/report')
  report(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.report(user, id);
  }

  @Post(':id/resend-failed')
  resendFailed(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.resendFailed(user, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.cancel(user, id);
  }
}
