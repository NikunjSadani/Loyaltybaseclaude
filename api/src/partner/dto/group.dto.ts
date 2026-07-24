import { IsOptional, IsString } from 'class-validator';

/**
 * Query DTO for GET /v1/partner/group/visibility.
 * `month` is an optional "YYYY-MM" filter (e.g. "2026-07"); when omitted the
 * service defaults to the current month. Mirrors the source visibility
 * outlet-statuses route's month param.
 */
export class GroupVisibilityQueryDto {
  @IsOptional()
  @IsString()
  month?: string;
}
