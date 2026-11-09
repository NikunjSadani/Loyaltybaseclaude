import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { OffersAdminService } from './offers-admin.service';
import { OffersPartnerService } from './offers-partner.service';
import {
  CopyMonthDto,
  CreateOfferTileDto,
  ListOffersQueryDto,
  UpdateOfferTileDto,
} from './dto/offers.dto';

/**
 * "This month's offers" admin API (platform/docs/plans/OFFER-TILES-PLAN.md §3.3). Thin adapter —
 * tenant context (400 for an un-assumed GIFSY_ADMIN), the per-tenant `offerTiles` flag (403 when
 * OFF) and all validation live in OffersAdminService. Static routes (`segment-options`,
 * `copy-month`) are declared BEFORE the `:id` routes.
 */
@Controller('admin/offers')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class OffersAdminController {
  constructor(private readonly svc: OffersAdminService) {}

  @Get()
  @RequirePermission('engagement:read')
  list(@CurrentUser() user: JwtPayload, @Query() q: ListOffersQueryDto) {
    return this.svc.list(user, q.month);
  }

  @Get('segment-options')
  @RequirePermission('engagement:read')
  options(@CurrentUser() user: JwtPayload) {
    return this.svc.segmentOptions(user);
  }

  @Post('copy-month')
  @HttpCode(201)
  @RequirePermission('engagement:manage_banners')
  copy(@CurrentUser() user: JwtPayload, @Body() dto: CopyMonthDto) {
    return this.svc.copyMonth(user, dto);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('engagement:manage_banners')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOfferTileDto) {
    return this.svc.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission('engagement:manage_banners')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateOfferTileDto) {
    return this.svc.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermission('engagement:manage_banners')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.remove(user, id);
  }
}

/**
 * GET /v1/partner/offers — tiles for the caller's ACTIVE outlet. `x-active-partner-id` is
 * re-authorized in the service (a forged selector → 403), never trusted blind.
 */
@Controller('partner/offers')
@Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
export class PartnerOffersController {
  constructor(private readonly svc: OffersPartnerService) {}

  @Get()
  @RequirePermission('engagement:read')
  list(@CurrentUser() user: JwtPayload, @Headers('x-active-partner-id') activePartnerId?: string) {
    return this.svc.listForPartner(user, activePartnerId);
  }
}
