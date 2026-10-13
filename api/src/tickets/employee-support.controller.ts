import { Body, Controller, Get, Post } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CreateTicketDto } from './dto/tickets.dto';

/**
 * Employee Rewards WS2 Wave 7 — the REP-facing "Contact support" rail on
 * /v1/rewards/employee/support. A roster employee raises a support ticket FOR THEMSELVES
 * into the SAME ticketing system the operator console + ops-dashboard SLA already use
 * (createEmployeeSupport reuses TicketsService.create), and lists their OWN tickets.
 *
 * Mirrors the other employee rails: intentionally NOT @Roles-gated (an employee's role is a
 * dynamic tenant hierarchy code, not a fixed allow-list) — authorization is the SERVICE-layer
 * own-identity resolution (resolveEmployeeReadContext) + the EMPLOYEE-earner tenant gate, which
 * also blocks a trade tenant. @RequirePermission('rewards:read') mirrors the member reads; the
 * operator-only support:write permission is deliberately NOT used here (an employee lacks it).
 */
@Controller('rewards/employee')
export class EmployeeSupportController {
  constructor(private readonly tickets: TicketsService) {}

  /** POST /v1/rewards/employee/support — raise a support ticket as the logged-in employee. */
  @Post('support')
  @RequirePermission('rewards:read')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateTicketDto) {
    return this.tickets.createEmployeeSupport(user, dto);
  }

  /** GET /v1/rewards/employee/support — the employee's OWN support tickets (newest first). */
  @Get('support')
  @RequirePermission('rewards:read')
  listMine(@CurrentUser() user: JwtPayload) {
    return this.tickets.listEmployeeSupport(user);
  }
}
