import { Body, Controller, Get, Post } from '@nestjs/common';
import { AdminOutletsService } from './admin-outlets.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  BulkDeleteOutletsDto,
  OutletCodesDto,
  ReKycFlagDto,
  UpsertOutletsDto,
} from './dto/admin-outlets.dto';

/**
 * Admin · Outlets API — re-homed from platform/src/app/api/admin/outlets/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); admin-only via
 * @Roles('GIFSY_ADMIN','CLIENT_ADMIN') (the source's ADMIN_ROLES gate); RBAC via
 * @RequirePermission (flag-gated, per the source's requirePermission key). Responses
 * are enveloped globally by TransformInterceptor.
 */
@Controller('admin/outlets')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class AdminOutletsController {
  constructor(private readonly outlets: AdminOutletsService) {}

  /** GET / — list the tenant's outlets (source: partners:manage_outlets). */
  @Get()
  @RequirePermission('partners:manage_outlets')
  list(@CurrentUser() user: JwtPayload) {
    return this.outlets.list(user);
  }

  /** POST /upsert — persist the Outlet Master upload (source: partners:manage_outlets). */
  @Post('upsert')
  @RequirePermission('partners:manage_outlets')
  upsert(@CurrentUser() user: JwtPayload, @Body() dto: UpsertOutletsDto) {
    return this.outlets.upsert(user, dto);
  }

  /** POST /rekyc-flag — persist the Re-KYC flag upload (source: kyc:initiate). */
  @Post('rekyc-flag')
  @RequirePermission('kyc:initiate')
  rekycFlag(@CurrentUser() user: JwtPayload, @Body() dto: ReKycFlagDto) {
    return this.outlets.rekycFlag(user, dto);
  }

  /** POST /bulk-delete — soft-delete by CUID ids (source: partners:delete). */
  @Post('bulk-delete')
  @RequirePermission('partners:delete')
  bulkDelete(@CurrentUser() user: JwtPayload, @Body() dto: BulkDeleteOutletsDto) {
    return this.outlets.bulkDelete(user, dto);
  }

  /** POST /deactivate — deactivate by outletCode (source: partners:write). */
  @Post('deactivate')
  @RequirePermission('partners:write')
  deactivate(@CurrentUser() user: JwtPayload, @Body() dto: OutletCodesDto) {
    return this.outlets.deactivate(user, dto);
  }

  /** POST /reactivate — reactivate by outletCode (source: partners:manage_outlets). */
  @Post('reactivate')
  @RequirePermission('partners:manage_outlets')
  reactivate(@CurrentUser() user: JwtPayload, @Body() dto: OutletCodesDto) {
    return this.outlets.reactivate(user, dto);
  }
}
