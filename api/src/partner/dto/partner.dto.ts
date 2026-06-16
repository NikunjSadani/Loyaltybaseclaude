import { IsOptional, IsString } from 'class-validator';

/**
 * Query DTO for GET /v1/partner/targets.
 * `period` is an optional "YYYY-MM" filter (e.g. "2026-05"); when omitted the
 * service returns all active scheme targets for the caller. Mirrors the source
 * route's `req.nextUrl.searchParams.get('period')` (string | null).
 */
export class ListPartnerTargetsQueryDto {
  @IsOptional()
  @IsString()
  period?: string;
}
