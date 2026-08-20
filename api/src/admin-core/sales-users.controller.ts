import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { UpdateEmployeeDto } from './dto/sales-users.dto';

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
