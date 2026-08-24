import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { VendorPortalService } from './vendor-portal.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  VendorCreateCatalogueDto,
  VendorFulfilmentDto,
  VendorTransitionDto,
  VendorUpdateCatalogueDto,
} from './dto/vendor.dto';

/**
 * VENDOR PORTAL (Wave 2) — /v1/vendor/*. @Roles('VENDOR') + the service HARD-scopes
 * EVERY query by user.vendorId AND user.clientId (and re-checks vendor ACTIVE + ACTIVE
 * grant on every request). Lists return { items }; detail/create/update return FLAT.
 */
@Controller('vendor')
@Roles('VENDOR')
export class VendorPortalController {
  constructor(private readonly portal: VendorPortalService) {}

  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return this.portal.getMe(user);
  }

  // ── Categories (shared GiftCategory taxonomy — the item category picker) ──────
  @Get('categories')
  listCategories(@CurrentUser() user: JwtPayload) {
    return this.portal.listCategories(user);
  }

  // ── Catalogue ───────────────────────────────────────────────────────────────
  @Get('catalogue')
  listCatalogue(@CurrentUser() user: JwtPayload) {
    return this.portal.listCatalogue(user);
  }

  /** GET /v1/vendor/catalogue/template — the blank xlsx bulk-upload template. */
  @Get('catalogue/template')
  async catalogueTemplate(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) _res: Response,
  ): Promise<StreamableFile> {
    const buffer = await this.portal.getCatalogueTemplate(user);
    const filename = `vendor-catalogue-template-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Post('catalogue')
  createCatalogue(@CurrentUser() user: JwtPayload, @Body() dto: VendorCreateCatalogueDto) {
    return this.portal.createCatalogue(user, dto);
  }

  @Post('catalogue/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) =>
        /\.(xlsx|xls)$/i.test(file.originalname)
          ? cb(null, true)
          : cb(new BadRequestException('Only .xlsx/.xls files are accepted'), false),
    }),
  )
  uploadCatalogue(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File) {
    return this.portal.uploadCatalogue(user, file);
  }

  @Patch('catalogue/:id')
  updateCatalogue(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: VendorUpdateCatalogueDto,
  ) {
    return this.portal.updateCatalogue(user, id, dto);
  }

  // ── Orders ────────────────────────────────────────────────────────────────────
  @Get('orders')
  listOrders(@CurrentUser() user: JwtPayload) {
    return this.portal.listOrders(user);
  }

  @Get('orders/:id')
  getOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.portal.getOrder(user, id);
  }

  @Patch('orders/:id/fulfilment')
  updateFulfilment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: VendorFulfilmentDto,
  ) {
    return this.portal.updateFulfilment(user, id, dto);
  }

  @Post('orders/:id/transition')
  transition(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: VendorTransitionDto,
  ) {
    return this.portal.transition(user, id, dto);
  }
}
