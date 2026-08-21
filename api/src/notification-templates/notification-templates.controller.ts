import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { NotificationTemplatesService } from './notification-templates.service';
import { SetNotificationTemplatesDto } from './dto/notification-templates.dto';
import { VARIABLE_CONTRACTS } from './notification-templates.config';

/**
 * Per-tenant notification-templates config — the Gifsy-admin portal side (Phase 2, config layer).
 *
 *   GET /v1/admin/notification-templates  → { config, contracts } — the resolved config for the
 *       operator's ASSUMED tenant (DB over defaults; every EVENT_KEY present; default mode OFF;
 *       whatsappTemplate seeded from WHATSAPP_KYC) plus the canonical VARIABLE_CONTRACTS.
 *   PUT /v1/admin/notification-templates  { masterSms, masterWhatsapp, events } → validate + upsert,
 *       returns the refreshed { config, contracts }.
 *
 * OWNER-ONLY: both routes are @Roles('GIFSY_ADMIN') (RolesGuard keeps GIFSY_STAFF and any tenant
 * role OUT — there is no fine @RequirePermission for the guard to defer to, so a non-owner falls
 * through to the allow-list → 403). The write is ADDITIONALLY re-checked at the data boundary
 * inside NotificationTemplatesService.saveConfig. The tenant acted on is the operator's assumed
 * tenant (user.clientId) — a Gifsy admin configures a brand by working inside it.
 */
@Controller('admin/notification-templates')
export class NotificationTemplatesController {
  constructor(private readonly svc: NotificationTemplatesService) {}

  @Get()
  @Roles('GIFSY_ADMIN')
  async get(@CurrentUser() user: JwtPayload) {
    const config = await this.svc.getConfig(user.clientId);
    return { config, contracts: VARIABLE_CONTRACTS };
  }

  @Put()
  @Roles('GIFSY_ADMIN')
  async put(@CurrentUser() user: JwtPayload, @Body() dto: SetNotificationTemplatesDto) {
    const config = await this.svc.saveConfig(user, dto);
    return { config, contracts: VARIABLE_CONTRACTS };
  }
}
