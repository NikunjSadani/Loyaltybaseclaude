import {
  IsOptional,
  IsString,
  IsIn,
  Matches,
  MinLength,
  MaxLength,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTOs for the self-bill visibility invoicing module (P6.7).
 * Tenant-scope is derived from JwtPayload.clientId — never accepted from clients.
 */

const PERIOD_RE = /^\d{4}-\d{2}$/;

// ── Generate ──────────────────────────────────────────────────────────────────

/**
 * POST /v1/admin/invoices/generate
 * Trigger automatic idempotent invoice generation for all outlets in a period.
 */
export class GenerateInvoicesDto {
  /** "YYYY-MM" — the period to generate invoices for. */
  @IsString()
  @Matches(PERIOD_RE, { message: 'period must be YYYY-MM' })
  period!: string;
}

// ── List ──────────────────────────────────────────────────────────────────────

/**
 * GET /v1/admin/invoices   (admin)
 * GET /v1/partner/invoices (partner)
 * Filter + pagination.
 */
export class ListInvoicesQueryDto {
  @IsOptional()
  @IsString()
  @Matches(PERIOD_RE, { message: 'period must be YYYY-MM' })
  period?: string;

  @IsOptional()
  @IsString()
  @IsIn(['GENERATED', 'PAID'])
  status?: string;

  @IsOptional()
  @IsString()
  outletCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// ── Update invoice number (#8) ────────────────────────────────────────────────

/**
 * PATCH /v1/partner/invoices/:id/invoice-number
 * PATCH /v1/admin/invoices/:id/invoice-number
 * Update a GENERATED invoice's number (locked once PAID).
 *
 * Validation: trim + uppercase; ^[A-Z0-9\-\/]+$ ; 1–60 chars.
 */
export class UpdateInvoiceNumberDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  // After trim+uppercase in the service, the persisted value must match ^[A-Z0-9\-\/]+$.
  // Accept mixed-case here; the service normalises before the DB uniqueness check.
  @Matches(/^[A-Za-z0-9\-\/]+$/, {
    message: 'invoiceNumber must contain only letters, digits, hyphens or slashes',
  })
  invoiceNumber!: string;
}
