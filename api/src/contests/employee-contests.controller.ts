import { Controller, Get } from '@nestjs/common';
import { ContestsService } from './contests.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Employee Rewards Phase C — the REP-facing contest read rail on /v1/rewards/employee/contests.
 * Display-only (banner/name/duration/bonus/eligibility) — NO money. Mirrors the other employee
 * read rails (RewardsController employee/*): intentionally NOT @Roles-gated (an employee's role is
 * a dynamic tenant hierarchy code, not a fixed allow-list), so authorization is the SERVICE-layer
 * own-identity resolution (resolveEmployeeReadContext) + the EMPLOYEE-earner tenant gate.
 * @RequirePermission('rewards:read') mirrors the member reads.
 */
@Controller('rewards/employee')
export class EmployeeContestsController {
  constructor(private readonly contests: ContestsService) {}

  @Get('contests')
  @RequirePermission('rewards:read')
  employeeContests(@CurrentUser() user: JwtPayload) {
    return this.contests.employeeContests(user);
  }
}
