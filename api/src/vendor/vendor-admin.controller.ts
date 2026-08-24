import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { VendorAdminService } from './vendor-admin.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreateVendorDto,
  CreateVendorGrantDto,
  CreateVendorUserDto,
  UpdateVendorDto,
  UpdateVendorGrantDto,
} from './dto/vendor.dto';

/**
 * Gifsy VENDOR MANAGEMENT (Wave 2) — /v1/admin/vendors. GIFSY-operator only:
 * @Roles('GIFSY_ADMIN') (owner) + the service's isGifsyOperator re-check. Reuses the
 * existing rewards permission keys (reads → rewards:read, writes → manage_inventory).
 * Lists return { items }; detail/create/update return the object FLAT.
 */
@Controller('admin/vendors')
@Roles('GIFSY_ADMIN')
export class VendorAdminController {
  constructor(private readonly vendors: VendorAdminService) {}

  @Get()
  @RequirePermission('rewards:read')
  list(@CurrentUser() user: JwtPayload) {
    return this.vendors.listVendors(user);
  }

  @Get(':id')
  @RequirePermission('rewards:read')
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.vendors.getVendor(user, id);
  }

  @Post()
  @RequirePermission('rewards:manage_inventory')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateVendorDto) {
    return this.vendors.createVendor(user, dto);
  }

  @Patch(':id')
  @RequirePermission('rewards:manage_inventory')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateVendorDto) {
    return this.vendors.updateVendor(user, id, dto);
  }

  @Post(':id/grants')
  @RequirePermission('rewards:manage_inventory')
  createGrant(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateVendorGrantDto,
  ) {
    return this.vendors.createGrant(user, id, dto);
  }

  @Patch(':id/grants/:grantId')
  @RequirePermission('rewards:manage_inventory')
  updateGrant(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
    @Body() dto: UpdateVendorGrantDto,
  ) {
    return this.vendors.updateGrant(user, id, grantId, dto);
  }

  @Post(':id/users')
  @RequirePermission('rewards:manage_inventory')
  createUser(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateVendorUserDto,
  ) {
    return this.vendors.createVendorUser(user, id, dto);
  }
}
