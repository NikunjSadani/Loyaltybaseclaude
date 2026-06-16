import { Body, Controller, Get, Put } from '@nestjs/common';
import { BannerConfigService } from './banner-config.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { UpdateBannerConfigDto } from './dto/banner-config.dto';

/**
 * Banner Config admin — re-homed from
 * platform/src/app/api/admin/banner-config/route.ts onto /v1.
 *
 * GET uses a partner-role denylist (enforced in the service), so it is not
 * gated with @Roles (allowlist-only); engagement:read still applies.
 */
@Controller('admin/banner-config')
export class BannerConfigController {
  constructor(private readonly bannerConfig: BannerConfigService) {}

  @Get()
  @RequirePermission('engagement:read')
  get(@CurrentUser() user: JwtPayload) {
    return this.bannerConfig.get(user);
  }

  @Put()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('engagement:manage_banners')
  update(@CurrentUser() user: JwtPayload, @Body() dto: UpdateBannerConfigDto) {
    return this.bannerConfig.update(user, dto);
  }
}
