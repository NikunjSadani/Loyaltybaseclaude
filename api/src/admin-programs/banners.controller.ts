import { Body, Controller, Delete, Get, HttpCode, Post, Query } from '@nestjs/common';
import { BannersService } from './banners.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CreateBannerDto, DeleteBannerQueryDto } from './dto/banners.dto';

/**
 * Banners admin — re-homed from
 * platform/src/app/api/admin/banners/route.ts onto /v1.
 *
 * GET is open to any authenticated caller (engagement:read); non-GIFSY callers
 * only see ACTIVE, non-expired banners (filtered in the service).
 */
@Controller('admin/banners')
export class BannersController {
  constructor(private readonly banners: BannersService) {}

  @Get()
  @RequirePermission('engagement:read')
  list(@CurrentUser() user: JwtPayload) {
    return this.banners.list(user);
  }

  @Post()
  @HttpCode(201)
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('engagement:manage_banners')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateBannerDto) {
    return this.banners.create(user, dto);
  }

  @Delete()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('engagement:manage_banners')
  remove(@CurrentUser() user: JwtPayload, @Query() query: DeleteBannerQueryDto) {
    return this.banners.remove(user, query.id);
  }
}
