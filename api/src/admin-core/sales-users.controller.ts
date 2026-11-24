import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { RetrySignOutDto, UpdateEmployeeDto } from './dto/sales-users.dto';

/**
 * Single-record EMPLOYEE edit — PATCH /v1/admin/sales-users/:id (`:id` = the
 * SalesUser id). Today an employee's hierarchy side (level / reporting line) is
 * ONLY editable via the bulk "Employee Hierarchy" Excel upload; this endpoint lets
 * an admin edit ONE employee directly. It updates BOTH the linked User (login) and
 * the SalesUser (hierarchy) atomically so the two rows can never drift.
 *
 * Role + permission match the bulk hierarchy endpoint (AdminHierarchyConfigController
 * PUT): GIFSY_ADMIN or CLIENT_ADMIN, gated by `sales_org:manage_hierarchy`. Tenant
 * scope + all business guards (phone/email uniqueness, operator-row protection,
 * level-in-tenant, reporting-cycle) are re-checked in the service.
 */
@Controller('admin/sales-users')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class AdminSalesUsersController {
  constructor(private readonly svc: AdminCoreService) {}

  /** Dropdown sources for the employee edit form: hierarchy levels + candidate managers. */
  @Get('options')
  @RequirePermission('sales_org:manage_hierarchy')
  options(@CurrentUser() user: JwtPayload) {
    return this.svc.getEmployeeOptions(user);
  }

  /**
   * Fetch ONE employee (AdminUser shape) by hierarchy employeeCode — powers the Hierarchy
   * tab's edit pencil. Same `sales_org:manage_hierarchy` gate as the edit itself, so the
   * open→edit round-trip needs only that one permission (no separate users:read), and it's
   * an exact lookup (no search-pagination cap). Static path declared before `:id`.
   */
  @Get('by-code/:code')
  @RequirePermission('sales_org:manage_hierarchy')
  byCode(@CurrentUser() user: JwtPayload, @Param('code') code: string) {
    return this.svc.getEmployeeByCode(user, code);
  }

  /**
   * "Retry sign-out" after a vacate / fill whose after-commit session revoke failed. Only a
   * login belonging to THIS position (current, or its closed vacant/former record) qualifies.
   */
  @Post(':id/revoke-sessions')
  @RequirePermission('sales_org:manage_hierarchy')
  retrySignOut(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RetrySignOutDto,
  ) {
    return this.svc.retryEmployeeSignOut(user, id, dto.userId);
  }

  @Patch(':id')
  @RequirePermission('sales_org:manage_hierarchy')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.svc.updateEmployee(user, id, dto);
  }
}
