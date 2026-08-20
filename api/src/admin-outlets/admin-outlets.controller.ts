import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AdminOutletsService } from './admin-outlets.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  BulkDeleteOutletsDto,
  ListOutletsQueryDto,
  OutletCodesDto,
  ReKycFlagDto,
  UpdateOutletDto,
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

  /**
   * GET /ids — the FULL tenant outlet list, UNPAGINATED, projected to only
   * { outletId, isActive, kycStatus } for the FE upload validators + header stats.
   * Registered BEFORE @Get() so the static 'ids' segment can never be shadowed.
   * (source: partners:manage_outlets — same read gate as the list.)
   */
  @Get('ids')
  @RequirePermission('partners:manage_outlets')
  listIds(@CurrentUser() user: JwtPayload) {
    return this.outlets.listIds(user);
  }

  /**
   * GET /parked — the tenant's currently PARKED outlets ({ outletId, name, city }) for the
   * FE "Download Parked Outlets" export. Registered BEFORE @Get() so the static 'parked'
   * segment can never be shadowed. (source: partners:manage_outlets — same read gate as /ids.)
   */
  @Get('parked')
  @RequirePermission('partners:manage_outlets')
  listParked(@CurrentUser() user: JwtPayload) {
    return this.outlets.listParked(user);
  }

  /** GET / — server-paginated + filtered tenant outlet list (source: partners:manage_outlets). */
  @Get()
  @RequirePermission('partners:manage_outlets')
  list(@CurrentUser() user: JwtPayload, @Query() query: ListOutletsQueryDto) {
    return this.outlets.list(user, query);
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

  /**
   * POST /park — PARK KYC-pending outlets by outletCode so they are FULLY hidden from sales
   * reps (reversible via /unpark). Mirrors the reactivate gate (partners:manage_outlets).
   */
  @Post('park')
  @RequirePermission('partners:manage_outlets')
  park(@CurrentUser() user: JwtPayload, @Body() dto: OutletCodesDto) {
    return this.outlets.park(user, dto);
  }

  /** POST /unpark — clear the PARKED intent by outletCode (source: partners:manage_outlets). */
  @Post('unpark')
  @RequirePermission('partners:manage_outlets')
  unpark(@CurrentUser() user: JwtPayload, @Body() dto: OutletCodesDto) {
    return this.outlets.unpark(user, dto);
  }

  /**
   * POST /:outletCode/ungroup — the DEDICATED, explicit un-group action (owner groups, §4.5).
   * Removes ONE outlet from its owner group; blocked while it still shares an enforced identity
   * detail (incl. phone) with the group. Un-grouping is NEVER a side effect of a blank upload
   * cell — only this endpoint. Same admin gate as grouping (partners:manage_outlets); the static
   * POST routes above are single-segment so this two-segment param route can't shadow them.
   */
  @Post(':outletCode/ungroup')
  @RequirePermission('partners:manage_outlets')
  ungroup(@CurrentUser() user: JwtPayload, @Param('outletCode') outletCode: string) {
    return this.outlets.ungroupOutlet(user, outletCode);
  }

  /**
   * PATCH /:outletCode — edit ONE outlet's MASTER fields directly (the single-record
   * equivalent of the bulk Outlet Master upsert). Only the Outlet-row columns the bulk upsert
   * can change are accepted (see UpdateOutletDto); identity/grouping/lifecycle/KYC fields are
   * NOT. Same admin gate as the bulk upsert (partners:manage_outlets); tenant-scoped in the
   * service (a cross-tenant outletCode 404s).
   */
  @Patch(':outletCode')
  @RequirePermission('partners:manage_outlets')
  updateOne(
    @CurrentUser() user: JwtPayload,
    @Param('outletCode') outletCode: string,
    @Body() dto: UpdateOutletDto,
  ) {
    return this.outlets.updateOne(user, outletCode, dto);
  }
}
