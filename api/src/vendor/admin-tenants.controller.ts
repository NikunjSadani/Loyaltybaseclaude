import { Controller, Get } from '@nestjs/common';
import { VendorAdminService } from './vendor-admin.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Tenant-options list (Wave 2) — GET /v1/admin/tenants. GIFSY-operator only. Powers the
 * vendor add-grant picker: ACTIVE REAL tenants only, EXCLUDING the 'gifsy' operator
 * tenant. Reuses VendorAdminService.listTenants (same Client-list logic + data-boundary
 * re-check). Returns { items: [{ id, name }] }.
 */
@Controller('admin/tenants')
@Roles('GIFSY_ADMIN')
export class AdminTenantsController {
  constructor(private readonly vendors: VendorAdminService) {}

  @Get()
  @RequirePermission('rewards:read')
  list(@CurrentUser() user: JwtPayload) {
    return this.vendors.listTenants(user);
  }
}
