import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { GiftCatalogueService } from './gift-catalogue.service';
import { GiftBackfillService } from './gift-backfill.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreateGiftCategoryDto,
  CreateGiftMasterDto,
  ListGiftMastersQueryDto,
  PublishGiftMasterDto,
  RejectModerationDto,
  UpdateGiftCategoryDto,
  UpdateGiftMasterDto,
} from './dto/gift-catalogue.dto';

/**
 * Gift Catalogue admin (Wave 1) — PLATFORM master + shared taxonomy + publish +
 * moderation. Routes are TOP-LEVEL to match the already-built FE contract:
 *   /v1/admin/gift-masters ·  /v1/admin/gift-categories  ·
 *   /v1/admin/gift-catalogue/moderation  ·  /v1/admin/gift-catalogue/backfill (ops-only).
 * Lists return { items }; detail returns the object FLAT.
 *
 * GIFSY-OPERATOR ONLY: @Roles('GIFSY_ADMIN') admits ONLY the owner role — a GIFSY_STAFF
 * keeps role 'GIFSY_STAFF' even when assumed, so this route gate does NOT admit staff
 * today (gift-catalogue admin is effectively owner-only until 'GIFSY_STAFF' is added to
 * @Roles). The service-layer isGifsyOperator re-check accepts both owner and staff, but
 * the @Roles gate is the binding constraint. Reuses the existing rewards permission keys
 * (no new RBAC key needed):
 *   reads  → rewards:read ; writes/publish/backfill → rewards:manage_inventory.
 */
@Controller('admin')
@Roles('GIFSY_ADMIN')
export class GiftCatalogueController {
  constructor(
    private readonly catalogue: GiftCatalogueService,
    private readonly backfill: GiftBackfillService,
  ) {}

  // ── GiftCategory (platform taxonomy) — /v1/admin/gift-categories ─────────────

  @Get('gift-categories')
  @RequirePermission('rewards:read')
  listCategories(@CurrentUser() user: JwtPayload) {
    return this.catalogue.listCategories(user);
  }

  @Post('gift-categories')
  @RequirePermission('rewards:manage_inventory')
  createCategory(@CurrentUser() user: JwtPayload, @Body() dto: CreateGiftCategoryDto) {
    return this.catalogue.createCategory(user, dto);
  }

  @Put('gift-categories/:id')
  @RequirePermission('rewards:manage_inventory')
  updateCategory(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateGiftCategoryDto,
  ) {
    return this.catalogue.updateCategory(user, id, dto);
  }

  @Delete('gift-categories/:id')
  @RequirePermission('rewards:manage_inventory')
  deleteCategory(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.catalogue.deleteCategory(user, id);
  }

  // ── GiftMaster — /v1/admin/gift-masters ─────────────────────────────────────

  @Get('gift-masters')
  @RequirePermission('rewards:read')
  listMasters(@CurrentUser() user: JwtPayload, @Query() q: ListGiftMastersQueryDto) {
    return this.catalogue.listMasters(user, q);
  }

  /** Per-tenant publish + pricing MATRIX (each candidate tenant + its conversionRate). */
  @Get('gift-masters/:id/publish')
  @RequirePermission('rewards:read')
  getPublishMatrix(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.catalogue.getPublishMatrix(user, id);
  }

  @Get('gift-masters/:id')
  @RequirePermission('rewards:read')
  getMaster(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.catalogue.getMaster(user, id);
  }

  @Post('gift-masters')
  @RequirePermission('rewards:manage_inventory')
  createMaster(@CurrentUser() user: JwtPayload, @Body() dto: CreateGiftMasterDto) {
    return this.catalogue.createMaster(user, dto);
  }

  /** Edit a master; also the RESTORE path (PUT { status: 'ACTIVE' }). */
  @Put('gift-masters/:id')
  @RequirePermission('rewards:manage_inventory')
  updateMaster(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateGiftMasterDto,
  ) {
    return this.catalogue.updateMaster(user, id, dto);
  }

  /** Soft-archive → status ARCHIVED + DISCONTINUE its published rows. */
  @Delete('gift-masters/:id')
  @RequirePermission('rewards:manage_inventory')
  archiveMaster(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.catalogue.archiveMaster(user, id);
  }

  /** Publish/re-price to tenants and/or unpublish from others. */
  @Post('gift-masters/:id/publish')
  @RequirePermission('rewards:manage_inventory')
  publish(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PublishGiftMasterDto,
  ) {
    return this.catalogue.publish(user, id, dto);
  }

  // ── Moderation — /v1/admin/gift-catalogue/moderation ────────────────────────

  @Get('gift-catalogue/moderation')
  @RequirePermission('rewards:read')
  listModeration(@CurrentUser() user: JwtPayload) {
    return this.catalogue.listModeration(user);
  }

  @Post('gift-catalogue/moderation/:id/approve')
  @RequirePermission('rewards:manage_inventory')
  approveModeration(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.catalogue.approveModeration(user, id);
  }

  @Post('gift-catalogue/moderation/:id/reject')
  @RequirePermission('rewards:manage_inventory')
  rejectModeration(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RejectModerationDto,
  ) {
    return this.catalogue.rejectModeration(user, id, dto.reason);
  }

  // ── Migration backfill (idempotent, Gifsy-run — NOT a prisma migration) ───────

  @Post('gift-catalogue/backfill')
  @RequirePermission('rewards:manage_inventory')
  runBackfill(@CurrentUser() user: JwtPayload, @Query('clientId') clientId?: string) {
    return this.backfill.run(user, clientId);
  }
}
