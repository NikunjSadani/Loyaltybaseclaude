import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreateRewardCatalogDto,
  CreateRewardCategoryDto,
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
}
