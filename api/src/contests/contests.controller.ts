import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ContestsService } from './contests.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreateContestDto,
  CreditContestBonusDto,
  ListContestsQueryDto,
  SetContestStatusDto,
  UpdateContestDto,
} from './dto/contests.dto';

/**
 * Employee Rewards Phase C — ADMIN Contests CRUD + manual bonus credit on /v1/admin/contests.
 * Thin HTTP adapter: auth + tenant scope from @CurrentUser(); GIFSY_ADMIN or CLIENT_ADMIN
 * (parity with the admin-rewards catalogue CRUD), RBAC via @RequirePermission. The service
 * enforces the EMPLOYEE-earner tenant gate (a trade tenant is rejected 400).
 *
 * Permission strings (from src/common/rbac/permissions.ts):
 *   - reads  → 'rewards:read'
 *   - writes → 'rewards:manage_inventory'  (incl. the money-adjacent credit-bonus)
 */
@Controller('admin/contests')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class ContestsController {
  constructor(private readonly contests: ContestsService) {}

  @Post()
  @RequirePermission('rewards:manage_inventory')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateContestDto) {
    return this.contests.createContest(user, dto);
  }

  @Get()
  @RequirePermission('rewards:read')
  list(@CurrentUser() user: JwtPayload, @Query() query: ListContestsQueryDto) {
    return this.contests.listContests(user, query);
  }

  @Get(':id')
  @RequirePermission('rewards:read')
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.contests.getContest(user, id);
  }

  @Patch(':id')
  @RequirePermission('rewards:manage_inventory')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateContestDto,
  ) {
    return this.contests.updateContest(user, id, dto);
  }

  @Post(':id/status')
  @RequirePermission('rewards:manage_inventory')
  setStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SetContestStatusDto,
  ) {
    return this.contests.setStatus(user, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermission('rewards:manage_inventory')
  cancel(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.contests.cancelContest(user, id);
  }

  /** MANUAL bonus credit — once-only; routes through the audited account-first credit primitive. */
  @Post(':id/credit-bonus')
  @RequirePermission('rewards:manage_inventory')
  creditBonus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreditContestBonusDto,
  ) {
    return this.contests.creditBonus(user, id, dto);
  }
}
