import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { InvoicesService } from './invoices.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  GenerateInvoicesDto,
  ListInvoicesQueryDto,
  UpdateInvoiceNumberDto,
} from './dto/invoices.dto';

/**
 * Self-bill visibility invoicing controller (P6.7).
 *
 * Admin routes — /v1/admin/invoices (CLIENT_ADMIN + GIFSY_ADMIN):
 *   GET    /v1/admin/invoices               → list all tenant invoices
 *   GET    /v1/admin/invoices/:id           → get by id
 *   POST   /v1/admin/invoices/generate      → trigger automatic generation for a period
 *   PATCH  /v1/admin/invoices/:id/mark-paid → transition GENERATED → PAID
 *   PATCH  /v1/admin/invoices/:id/invoice-number → update invoice number (GENERATED only)
 *
 * Partner routes — /v1/partner/invoices (partner roles):
 *   GET    /v1/partner/invoices             → list own invoices
 *   GET    /v1/partner/invoices/:id         → get own invoice by id
 *   PATCH  /v1/partner/invoices/:id/invoice-number → update own invoice number
 *
 * Tenant-scope is enforced in the service via user.clientId (from the JWT).
 * Partner-scope is enforced in the service by resolving ChannelPartner.userId = user.sub.
 */

// ── Admin controller ──────────────────────────────────────────────────────────

@Controller('admin/invoices')
@Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
export class AdminInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query() q: ListInvoicesQueryDto) {
    return this.invoices.list(user, q);
  }

  /**
   * GET /v1/admin/invoices/export?period=&status=&outletCode=
   * Tenant-scoped .xlsx of the filtered invoice set (#44). Registered BEFORE
   * `:id` so "export" is not swallowed by the param route.
   */
  @Get('export')
  async export(
    @CurrentUser() user: JwtPayload,
    @Query() q: ListInvoicesQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.invoices.exportXlsx(user, q);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  /**
   * GET /v1/admin/invoices/template → blank upload template .xlsx (#44).
   * Registered BEFORE `:id`.
   */
  @Get('template')
  template(@Res({ passthrough: true }) res: Response): StreamableFile {
    const buffer = this.invoices.uploadTemplate();
    res.setHeader('Content-Disposition', 'attachment; filename="invoice-upload-template.xlsx"');
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  @Get(':id')
  getById(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.invoices.getById(user, id);
  }

  @Post('generate')
  generate(@CurrentUser() user: JwtPayload, @Body() dto: GenerateInvoicesDto) {
    return this.invoices.generateForPeriod(user, dto);
  }

  @Patch(':id/mark-paid')
  @Roles('GIFSY_ADMIN')
  markPaid(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.invoices.markPaid(user, id);
  }

  @Patch(':id/invoice-number')
  updateInvoiceNumber(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceNumberDto,
  ) {
    return this.invoices.updateInvoiceNumber(user, id, dto);
  }
}

// ── Partner controller ────────────────────────────────────────────────────────

@Controller('partner/invoices')
@Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
export class PartnerInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query() q: ListInvoicesQueryDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.invoices.list(user, q, activePartnerId);
  }

  /**
   * GET /v1/partner/invoices/export — partner-scoped .xlsx of their own invoices
   * (#44). The service restricts to the caller's partnerId; a caller with no
   * partner record gets a header-only sheet (never a tenant-wide leak).
   * Registered BEFORE `:id`.
   */
  @Get('export')
  async export(
    @CurrentUser() user: JwtPayload,
    @Query() q: ListInvoicesQueryDto,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.invoices.exportXlsx(user, q, activePartnerId);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  @Get(':id')
  getById(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.invoices.getById(user, id, activePartnerId);
  }

  @Patch(':id/invoice-number')
  updateInvoiceNumber(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceNumberDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.invoices.updateInvoiceNumber(user, id, dto, activePartnerId);
  }
}
