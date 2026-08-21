import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { WhatsappTemplatesService } from './whatsapp-templates.service';
import {
  CreateWhatsappTemplateDto,
  UpdateWhatsappTemplateDto,
} from './dto/whatsapp-template.dto';

/**
 * WhatsApp template library — `/v1/admin/whatsapp-templates`. Gifsy-operator only.
 *
 * OWNER-ONLY at the route: `@Roles('GIFSY_ADMIN')` with NO `@RequirePermission` — so
 * RolesGuard keeps every tenant role (CLIENT_ADMIN, MIS_USER, …) AND un-permissioned
 * GIFSY_STAFF OUT (they fall through the allow-list → 403), mirroring the notification-
 * templates controller. The tenant acted on is the operator's ASSUMED tenant
 * (`user.clientId`); the service ADDITIONALLY re-checks isGifsyOperator at the data
 * boundary. Responses enveloped globally by TransformInterceptor.
 */
@Controller('admin/whatsapp-templates')
@Roles('GIFSY_ADMIN')
export class WhatsappTemplatesController {
  constructor(private readonly svc: WhatsappTemplatesService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.svc.list(user);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateWhatsappTemplateDto) {
    return this.svc.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateWhatsappTemplateDto,
  ) {
    return this.svc.update(user, id, dto);
  }

  @Delete(':id')
  archive(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.archive(user, id);
  }
}
