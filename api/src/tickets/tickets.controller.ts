import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { TicketsService } from './tickets.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { externalOrigin } from '../exports/exports.service';
import {
  AddMessageDto,
  AssignTicketDto,
  ClientRemarksReplyDto,
  CreateTicketDto,
  EscalateTicketDto,
  ListTicketsQueryDto,
  RequestClientRemarksDto,
  SetTicketStatusDto,
} from './dto/tickets.dto';

/**
 * Support tickets API — re-homed from platform/src/app/api/tickets/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated); GIFSY-only actions via @Roles('GIFSY_ADMIN') (a
 * GIFSY_STAFF passes @Roles when its GifsyRole grants the route's permission) and
 * re-checked in the service. Responses are enveloped globally by TransformInterceptor.
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

  /** Assign-to / escalate-to picker options (Gifsy operators only). */
  @Get(':id/assignees')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('support:write')
  listAssignees(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.tickets.listAssignees(user, id);
  }

  @Post(':id/assign')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('support:write')
  assign(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: AssignTicketDto) {
    return this.tickets.assign(user, id, dto);
  }

  @Post(':id/escalate')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('support:escalate')
  escalate(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: EscalateTicketDto) {
    return this.tickets.escalate(user, id, dto);
  }

  /** Gifsy asks a client admin of the ticket's tenant for remarks (bell + email). */
  @Post(':id/request-client-remarks')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('support:escalate')
  requestClientRemarks(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RequestClientRemarksDto,
    @Req() req: Request,
  ) {
    return this.tickets.requestClientRemarks(user, id, dto, externalOrigin(req));
  }

  /** The client admin's reply to a remarks request (stored INTERNAL). */
  @Post(':id/client-remarks')
  @Roles('CLIENT_ADMIN')
  @RequirePermission('support:write')
  replyClientRemarks(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: ClientRemarksReplyDto) {
    return this.tickets.replyClientRemarks(user, id, dto);
  }

  @Post(':id/status')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER')
  @RequirePermission('support:write')
  setStatus(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetTicketStatusDto) {
    return this.tickets.setStatus(user, id, dto);
  }

  @Post(':id/messages')
  @RequirePermission('support:write')
  addMessage(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: AddMessageDto) {
    return this.tickets.addMessage(user, id, dto);
  }
}
