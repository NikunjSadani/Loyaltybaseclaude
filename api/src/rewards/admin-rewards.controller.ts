import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { RewardsService } from './rewards.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreateRewardCatalogDto,
  CreateRewardCategoryDto,
  FulfilmentTemplateQueryDto,
  ListCatalogQueryDto,
  UpdateRewardCatalogDto,
  UpdateRewardCategoryDto,
} from './dto/rewards.dto';

/**
 * Admin Reward Catalog CRUD (P5.3) — real `RewardCategory` / `RewardCatalog`
 * write endpoints on /v1/admin/rewards/*. These SUPERSEDE the World-B
 * `admin/gift-config` JSON blob + `lib/gifts.ts` demo (retired with the FE in
 * 5.5). Thin adapter: auth + tenant scope from @CurrentUser(); RBAC via
 * @RequirePermission; GIFSY_ADMIN or CLIENT_ADMIN (parity with gift-config).
 *
 * Permission strings (from src/common/rbac/permissions.ts):
 *   - reads  → 'rewards:read'
 *   - writes → 'rewards:manage_inventory'
 */
@Controller('admin/rewards')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class AdminRewardsController {
  constructor(private readonly rewards: RewardsService) {}

  // ─── Categories ────────────────────────────────────────────────────────────

  @Post('categories')
  @RequirePermission('rewards:manage_inventory')
  createCategory(@CurrentUser() user: JwtPayload, @Body() dto: CreateRewardCategoryDto) {
    return this.rewards.createCategory(user, dto);
  }

  @Get('categories')
  @RequirePermission('rewards:read')
  listCategories(@CurrentUser() user: JwtPayload) {
    return this.rewards.listCategories(user);
  }

  @Patch('categories/:id')
  @RequirePermission('rewards:manage_inventory')
  updateCategory(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateRewardCategoryDto,
  ) {
    return this.rewards.updateCategory(user, id, dto);
  }

  @Delete('categories/:id')
  @RequirePermission('rewards:manage_inventory')
  deleteCategory(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.rewards.deleteCategory(user, id);
  }

  // ─── Catalog items ───────────────────────────────────────────────────────────

  @Get('catalog')
  @RequirePermission('rewards:read')
  listCatalog(@CurrentUser() user: JwtPayload, @Query() query: ListCatalogQueryDto & { status?: string; categoryId?: string }) {
    return this.rewards.adminListCatalog(user, query);
  }

  @Post('catalog')
  @RequirePermission('rewards:manage_inventory')
  createCatalogItem(@CurrentUser() user: JwtPayload, @Body() dto: CreateRewardCatalogDto) {
    return this.rewards.createCatalogItem(user, dto);
  }

  @Patch('catalog/:id')
  @RequirePermission('rewards:manage_inventory')
  updateCatalogItem(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateRewardCatalogDto,
  ) {
    return this.rewards.updateCatalogItem(user, id, dto);
  }

  @Delete('catalog/:id')
  @RequirePermission('rewards:manage_inventory')
  deleteCatalogItem(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.rewards.deleteCatalogItem(user, id);
  }

  // ─── Bulk fulfilment (P5.4b) — GIFSY-only ops download → fill → upload ────────
  //
  // These mirror the P4 targets template/upload endpoints (StreamableFile +
  // FileInterceptor) and the payout download→fill→upload flow. GIFSY_ADMIN only
  // (method-level @Roles overrides the class-level GIFSY/CLIENT mix) +
  // rewards:manage_orders (the same key gating the per-order transition).

  /**
   * GET /v1/admin/rewards/fulfilment/template?status=&mode=
   * Streams an .xlsx of tenant orders awaiting fulfilment for the ops user to fill.
   */
  @Get('fulfilment/template')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('rewards:manage_orders')
  async getFulfilmentTemplate(
    @CurrentUser() user: JwtPayload,
    @Query() q: FulfilmentTemplateQueryDto,
    @Res({ passthrough: true }) _res: Response,
  ): Promise<StreamableFile> {
    const buffer = await this.rewards.getFulfilmentTemplate(user, q);
    const filename = `rewards-fulfilment-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /**
   * POST /v1/admin/rewards/fulfilment/upload  (multipart/form-data, field: "file")
   * Parses the filled sheet and applies each row via the guarded transition /
   * non-status update. One bad row is collected, not fatal.
   */
  @Post('fulfilment/upload')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('rewards:manage_orders')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB ceiling — bound memory on parse
      fileFilter: (_req, file, cb) =>
        /\.(xlsx|xls)$/i.test(file.originalname)
          ? cb(null, true)
          : cb(new BadRequestException('Only .xlsx/.xls files are accepted'), false),
    }),
  )
  uploadFulfilment(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.rewards.uploadFulfilment(user, file);
  }
}
