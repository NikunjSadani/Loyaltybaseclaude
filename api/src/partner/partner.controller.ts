import { Controller, Get, Query } from '@nestjs/common';
import { PartnerService } from './partner.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ListPartnerTargetsQueryDto } from './dto/partner.dto';

/**
 * Partner self-service API — re-homed from platform/src/app/api/partner/* onto
 * /v1. Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC
 * via @RequirePermission (flag-gated). All routes are caller-scoped reads; no
 * @Roles gating since the source routes admitted all authenticated roles.
 * Responses are enveloped globally by TransformInterceptor.
 */
@Controller('partner')
export class PartnerController {
  constructor(private readonly partner: PartnerService) {}

  @Get('me')
  getMe(@CurrentUser() user: JwtPayload) {
    return this.partner.getMe(user);
  }

  @Get('banners')
  @RequirePermission('engagement:read')
  getBanners(@CurrentUser() user: JwtPayload) {
    return this.partner.getBanners(user);
  }

  @Get('payouts')
  @RequirePermission('payouts:read')
  getPayouts(@CurrentUser() user: JwtPayload) {
    return this.partner.getPayouts(user);
  }

  @Get('targets')
  @RequirePermission('targets:read')
  getTargets(@CurrentUser() user: JwtPayload, @Query() query: ListPartnerTargetsQueryDto) {
    return this.partner.getTargets(user, query);
  }
}
