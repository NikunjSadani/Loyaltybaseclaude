import { Body, Controller, Get, Param, Post, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { RewardStockService } from './reward-stock.service';
import { ResolveStockReviewDto } from './dto/rewards.dto';

/**
 * Reward STOCK HISTORY (owner-approved 2026-11-26, all clients) — same roles / permissions / tenant scope as the
 * admin catalogue (AdminRewardsController): reads 'rewards:read', decisions 'rewards:manage_inventory'.
 */
@Controller('admin/rewards')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class AdminRewardStockController {
  constructor(private readonly stock: RewardStockService) {}

  @Get('catalog/:id/stock-history')
  @RequirePermission('rewards:read')
  history(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.stock.getHistory(user, id);
  }

  @Get('catalog/:id/stock-history/export')
  @RequirePermission('rewards:read')
  async export(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res({ passthrough: true }) _res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.stock.exportHistory(user, id);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('stock-reviews')
  @RequirePermission('rewards:read')
  reviews(@CurrentUser() user: JwtPayload) {
    return this.stock.listReviews(user);
  }

  @Post('stock-reviews/:id/resolve')
  @RequirePermission('rewards:manage_inventory')
  resolve(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: ResolveStockReviewDto) {
    return this.stock.resolveReview(user, id, dto.action, dto.note);
  }
}
