import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { AddMessageDto, CreateTicketDto, EscalateTicketDto, ListTicketsQueryDto } from './dto/tickets.dto';

/**
 * Support tickets API — re-homed from platform/src/app/api/tickets/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated); GIFSY-only escalate via @Roles. Responses are
 * enveloped globally by TransformInterceptor.
 */
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @RequirePermission('support:read')
  list(@CurrentUser() user: JwtPayload, @Query() query: ListTicketsQueryDto) {
    return this.tickets.list(user, query);
  }

  @Post()
  @RequirePermission('support:write')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateTicketDto) {
    return this.tickets.create(user, dto);
  }

  @Get(':id')
  @RequirePermission('support:read')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.tickets.getOne(user, id);
  }

  @Post(':id/escalate')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('support:escalate')
  escalate(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: EscalateTicketDto) {
    return this.tickets.escalate(user, id, dto);
  }

  @Post(':id/messages')
  @RequirePermission('support:write')
  addMessage(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: AddMessageDto) {
    return this.tickets.addMessage(user, id, dto);
  }
}
