import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /v1/admin/off-portal-payments[/export] */
export class OffPortalListQueryDto {
  @IsOptional() @Matches(DATE_RE, { message: 'from must be a date (YYYY-MM-DD)' }) from?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'to must be a date (YYYY-MM-DD)' }) to?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['INCENTIVE', 'VISIBILITY']) stream?: 'INCENTIVE' | 'VISIBILITY';
  @IsOptional() @IsIn(['CASH', 'GIFT']) mode?: 'CASH' | 'GIFT';
  @IsOptional() @IsIn(['ACTIVE', 'VOIDED', 'ALL']) status?: 'ACTIVE' | 'VOIDED' | 'ALL';
  @IsOptional() @IsString() @MaxLength(40) uploadId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

/** POST /v1/admin/off-portal-payments/confirm (multipart: file + these fields). */
export class OffPortalConfirmDto {
  @IsString() @IsNotEmpty() @Matches(/^[0-9a-f]{64}$/, { message: 'fileSha256 must be the preview fingerprint' }) fileSha256!: string;
  /** Comma-separated (multipart) or repeated field — the warning categories ticked. */
  @IsOptional() acknowledged?: string | string[];
}

/** POST /v1/admin/off-portal-payments/:id/void */
export class OffPortalVoidDto {
  @IsString() @IsNotEmpty({ message: 'A reason is required' }) @MaxLength(500) reason!: string;
}
