import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
  list(@CurrentUser() user: JwtPayload, @Query() q: ListInvoicesQueryDto) {
    return this.invoices.list(user, q);
  }

  @Get(':id')
  getById(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.invoices.getById(user, id);
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
