import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { GifsyService } from './gifsy.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  BrandingAssetDto,
  CreateClientDto,
  UpdateClientDto,
  UpdateOutletTypeConfigDto,
  UpdateWalletSettingsDto,
} from './dto/gifsy.dto';

/**
 * GIFSY platform super-admin API — re-homed from
 * platform/src/app/api/gifsy/clients/* onto /v1. Every route is GIFSY_ADMIN-only
 * (@Roles) and operates cross-tenant by design: client listing spans all tenants
 * and outlet-type configs are keyed by the path :slug, not the caller's clientId.
 * RBAC via @RequirePermission (flag-gated); responses enveloped globally.
 */
@Controller('gifsy')
export class GifsyController {
  constructor(private readonly gifsy: GifsyService) {}

  @Get('overview')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:read')
  getOverview(@CurrentUser() user: JwtPayload) {
    return this.gifsy.getOverview(user);
  }

  @Post('clients')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:write')
  createClient(@CurrentUser() user: JwtPayload, @Body() dto: CreateClientDto) {
    return this.gifsy.createClient(user, dto);
  }

  @Patch('clients/:slug')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:write')
  updateClient(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: UpdateClientDto,
  ) {
    return this.gifsy.updateClient(user, slug, dto);
  }

  /**
   * POST /v1/gifsy/clients/:slug/branding-asset — upload a branding image and
   * persist its URL onto the client's branding blob. Same GIFSY_ADMIN +
   * tenancy:write gate as the client PATCH. The image rides as multipart field
   * `file`; the target slot (`kind`) rides as a multipart form field.
   */
  @Post('clients/:slug/branding-asset')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadBrandingAsset(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: BrandingAssetDto,
  ) {
    return this.gifsy.uploadBrandingAsset(user, slug, file, dto.kind);
  }

  @Get('clients')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:read')
  listClients(@CurrentUser() user: JwtPayload) {
    return this.gifsy.listClients(user);
  }

  @Get('clients/:slug')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:read')
  getClientDetail(@CurrentUser() user: JwtPayload, @Param('slug') slug: string) {
    return this.gifsy.getClientDetail(user, slug);
  }

  /**
   * GET /v1/gifsy/clients/:slug/wallet-settings — the target tenant's REAL wallet
   * money settings (conversion rate, points-expiry days, redemption ₹ floors), read
   * from the same per-tenant stores the money path enforces. GIFSY_ADMIN only.
   */
  @Get('clients/:slug/wallet-settings')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:read')
  getWalletSettings(@CurrentUser() user: JwtPayload, @Param('slug') slug: string) {
    return this.gifsy.getWalletSettings(user, slug);
  }

  /**
   * PUT /v1/gifsy/clients/:slug/wallet-settings — write the target tenant's wallet
   * money settings, delegating to the SAME conversion-rate / points-expiry / floor
   * writes the tenant Settings panel uses (money path — conversion rate is validated
   * hard and can never be 0/negative). GIFSY_ADMIN only.
   */
  @Put('clients/:slug/wallet-settings')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:write')
  updateWalletSettings(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: UpdateWalletSettingsDto,
  ) {
    return this.gifsy.updateWalletSettings(user, slug, dto);
  }

  @Get('clients/:slug/outlet-type-configs')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:read')
  getOutletTypeConfigs(@CurrentUser() user: JwtPayload, @Param('slug') slug: string) {
    return this.gifsy.getOutletTypeConfigs(user, slug);
  }

  @Put('clients/:slug/outlet-type-configs/:code')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:write')
  updateOutletTypeConfig(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Param('code') code: string,
    @Body() dto: UpdateOutletTypeConfigDto,
  ) {
    return this.gifsy.updateOutletTypeConfig(user, slug, code, dto);
  }
}
